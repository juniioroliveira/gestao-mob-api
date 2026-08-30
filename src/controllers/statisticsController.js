const db = require('../config/database');
const { getIo } = require('../websockets/socket');
const { triggerUpdate } = require('../services/financialEventService');

// transactions.member_id vem como um int solto, string de int, ou array JSON tipo
// "[1,2]" pra transação rateada entre membros. Mesmo parsing usado em outros
// controllers (contas fixas, home) — mantém o critério de "rateio" consistente.
function parseMemberIds(memberIdRaw) {
    if (memberIdRaw === null || memberIdRaw === undefined) return [];
    try {
        const str = memberIdRaw.toString();
        if (str.startsWith('[')) {
            const parsed = JSON.parse(str);
            return Array.isArray(parsed) ? parsed.map(Number) : [];
        }
        const n = parseInt(str, 10);
        return isNaN(n) ? [] : [n];
    } catch (e) {
        return [];
    }
}

exports.getStatisticsData = (req, res) => {
    const familyId = req.user.family_id;
    // scope=family: mesmo padrão usado em /api/fixed-expenses — telas que comparam
    // ou somam entre membros (ex: "Controle por Categoria" da Carteira) pedem isso
    // pra ver o gasto e a renda da família inteira, não só do usuário logado. Sem
    // o parâmetro, comportamento continua idêntico ao de sempre (só o próprio usuário).
    const familyScope = req.query.scope === 'family';
    const currentUserId = familyScope ? null : req.user.id;

    // Pega o mês e ano da query string ou usa o atual por padrão
    const reqMonth = req.query.month ? parseInt(req.query.month, 10) : new Date().getMonth() + 1;
    const reqYear = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    
    const currentMonth = reqMonth; // 1 a 12
    const currentYear = reqYear;

    const monthStr = currentMonth.toString().padStart(2, '0');
    const yearStr = currentYear.toString();
    const targetMonthStr = `${yearStr}-${monthStr}`;

    // Categorias + orçamento do mês. O limite é um PERCENTUAL da renda (de quem está
    // vendo), não mais um valor em R$ travado — "spent" e o R$ do limite são
    // recalculados mais abaixo, depois que soubermos a renda relevante.
    const query = `
        SELECT
            c.id, c.name, c.color_hex, c.icon, c.type,
            cb.budget_percent
        FROM categories c
        LEFT JOIN category_budgets cb ON c.id = cb.category_id AND cb.month = ? AND cb.year = ?
        WHERE c.family_id = ?
    `;

    const runMainQuery = () => {
        db.all(query, [currentMonth, currentYear, familyId], (err, rows) => {
            if (err) {
                console.error('Erro ao buscar estatísticas:', err);
                return res.status(500).json({ error: 'Erro interno no servidor' });
            }

            const categoriesMeta = rows.map(row => ({
                id: row.id,
                name: row.name,
                color: row.color_hex || '#CCCCCC',
                icon: row.icon || 'category',
                type: row.type || 'EXPENSE',
                percent: row.budget_percent != null ? Number(row.budget_percent) : 0,
            }));

            // Buscar histórico de transações do mês
            const transactionsQuery = `
                SELECT t.id, t.amount, t.type, t.description, t.note, t.transaction_date,
                       t.account_id, t.destination_account_id, t.category_id, t.member_id, t.payment_type, t.recurring_bill_id,
                       a.name as account_name, 
                       c.icon, c.color_hex 
                FROM transactions t 
                JOIN accounts a ON t.account_id = a.id 
                LEFT JOIN categories c ON t.category_id = c.id 
                WHERE a.family_id = ? 
                  AND DATE_FORMAT(
                     CASE 
                         WHEN a.type = 'CREDIT' THEN
                             DATE_ADD(
                                 t.transaction_date, 
                                 INTERVAL (
                                     (CASE WHEN DAY(t.transaction_date) >= COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END) +
                                     (CASE WHEN COALESCE(a.due_day, 1) < COALESCE(a.closing_day, 31) THEN 1 ELSE 0 END)
                                 ) MONTH
                             )
                         ELSE t.transaction_date 
                     END, 
                     '%Y-%m'
                  ) = ?
                ORDER BY t.transaction_date DESC, t.id DESC
            `;

            db.all(transactionsQuery, [familyId, targetMonthStr], (err2, transactionsRows) => {
                if (err2) {
                    console.error('Erro ao buscar transações na estatística:', err2);
                    return res.status(500).json({ error: 'Erro interno no servidor' });
                }

                // Precisamos buscar os membros para mapear os nomes
                db.all(`SELECT id, name FROM members WHERE family_id = ?`, [familyId], (err4, membersRows) => {
                    const members = membersRows || [];

                    // Por usuário: só entra transação em que o usuário logado está entre os
                    // donos — sem member_id definido não existe pra transação (sempre tem um
                    // responsável), mas se for rateada (array com vários ids) ainda aparece
                    // normalmente pra todo mundo que está nela. Em scope=family, todo mundo entra.
                    const myTransactionsRows = familyScope
                        ? transactionsRows
                        : transactionsRows.filter(t => parseMemberIds(t.member_id).includes(currentUserId));

                    const finalTransactions = myTransactionsRows.map(t => {
                        let memberName = 'Desconhecido';
                        try {
                            const memIds = JSON.parse(t.member_id);
                            if (Array.isArray(memIds)) {
                                const names = memIds.map(id => {
                                    const m = members.find(mem => mem.id === id);
                                    return m ? m.name.split(' ')[0] : '';
                                }).filter(Boolean);
                                memberName = names.length > 1 ? names.join(', ') : (names[0] || 'Desconhecido');
                            } else {
                                const m = members.find(mem => mem.id === memIds);
                                memberName = m ? m.name : 'Desconhecido';
                            }
                        } catch (e) {
                            const m = members.find(mem => mem.id === t.member_id);
                            memberName = m ? m.name : 'Desconhecido';
                        }
                        return { ...t, member_name: memberName };
                    });

                    // Recalcula "spent" por categoria e o total de despesas a partir das
                    // transações já filtradas por usuário (rateio: se a transação é
                    // compartilhada com outro membro, conta o valor cheio mesmo assim, pois
                    // representa o gasto real que passou pela conta do usuário).
                    let totalExpense = 0;
                    const spentByCategory = {};
                    myTransactionsRows.forEach(t => {
                        if (t.type !== 'EXPENSE') return;
                        const amount = Number(t.amount) || 0;
                        totalExpense += amount;
                        if (t.category_id != null) {
                            spentByCategory[t.category_id] = (spentByCategory[t.category_id] || 0) + amount;
                        }
                    });
                    // Renda declarada — só a do usuário logado, não a soma da família (a
                    // menos que seja scope=family, aí soma todo mundo). O limite de cada
                    // categoria (em R$) é sempre o percentual salvo aplicado sobre ESSA
                    // renda, calculado na hora — nunca um valor travado no banco.
                    const incomeQuery = familyScope
                        ? `SELECT COALESCE(SUM(monthly_income), 0) as totalIncome FROM members WHERE family_id = ?`
                        : `SELECT COALESCE(monthly_income, 0) as totalIncome FROM members WHERE family_id = ? AND id = ?`;
                    const incomeParams = familyScope ? [familyId] : [familyId, currentUserId];
                    db.get(incomeQuery, incomeParams, (err3, incomeRow) => {
                        if (err3) {
                            console.error('Erro ao buscar receitas na estatística:', err3);
                            return res.status(500).json({ error: 'Erro interno no servidor' });
                        }

                        const totalIncome = incomeRow ? incomeRow.totalIncome : 0;
                        const categories = categoriesMeta.map(cat => {
                            const spent = spentByCategory[cat.id] || 0;
                            const limit = (cat.percent / 100) * totalIncome;
                            return {
                                ...cat,
                                spent,
                                limit,
                                percentage: limit > 0 ? (spent / limit) : 0
                            };
                        });

                        res.json({
                            totalExpense,
                            totalIncome,
                            categories,
                            transactions: finalTransactions
                        });
                    });
                });
            });
        });
    };

    // Auto-correção: garante que a família tenha pelo menos uma categoria INCOME.
    // Se não tiver, promove 'Salário' (ou similar) para INCOME.
    db.get(
        `SELECT COUNT(*) as count FROM categories WHERE family_id = ? AND type = 'INCOME'`,
        [familyId],
        (errCheck, checkRow) => {
            if (!errCheck && checkRow && checkRow.count === 0) {
                db.run(
                    `UPDATE categories SET type = 'INCOME' 
                     WHERE family_id = ? 
                       AND (LOWER(name) LIKE 'salário%' OR LOWER(name) LIKE 'salario%' OR LOWER(name) = 'receita' OR LOWER(name) = 'renda')`,
                    [familyId],
                    (errUpd) => {
                        if (errUpd) console.error('Erro ao promover categoria para INCOME:', errUpd);
                        runMainQuery();
                    }
                );
            } else {
                runMainQuery();
            }
        }
    );
};

exports.createCategory = (req, res) => {
    const familyId = req.user.family_id;
    const { name, color, icon, type, percent } = req.body;

    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    if (!name) return res.status(400).json({ error: 'O nome da categoria é obrigatório' });

    const insertQuery = `INSERT INTO categories (family_id, name, type, color_hex, icon) VALUES (?, ?, ?, ?, ?)`;

    db.run(insertQuery, [familyId, name, type || 'EXPENSE', color || '#CCCCCC', icon || 'category'], function(err) {
        if (err) return res.status(500).json({ error: 'Erro ao criar categoria' });

        const categoryId = this.lastID;

        // Se um percentual foi enviado, salva na tabela de orçamentos para o mês atual.
        // O limite em R$ é sempre derivado desse percentual na hora de exibir, nunca
        // gravado como valor fixo aqui.
        if (percent !== undefined && percent >= 0) {
            db.run(
                `INSERT INTO category_budgets (category_id, month, year, budget_percent) VALUES (?, ?, ?, ?)`,
                [categoryId, currentMonth, currentYear, percent],
                (err2) => {
                    if (err2) console.error('Erro ao salvar limite', err2);
                    getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'created' });
                    triggerUpdate(familyId);
                    res.status(201).json({ message: 'Categoria criada com limite', id: categoryId });
                }
            );
        } else {
            getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'created' });
            triggerUpdate(familyId);
            res.status(201).json({ message: 'Categoria criada', id: categoryId });
        }
    });
};

exports.updateCategory = (req, res) => {
    const familyId = req.user.family_id;
    const categoryId = req.params.id;
    const { name, color, icon, percent } = req.body;

    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    // Primeiro garante que a categoria pertence à família
    db.get(`SELECT id FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Categoria não encontrada ou sem permissão' });

        const updates = [];
        const params = [];

        if (name) { updates.push('name = ?'); params.push(name); }
        if (color) { updates.push('color_hex = ?'); params.push(color); }
        if (icon) { updates.push('icon = ?'); params.push(icon); }

        const updateCategoryAndLimit = () => {
            if (percent !== undefined && percent >= 0) {
                // Atualiza ou insere o percentual para o mês atual (Upsert)
                const upsertLimit = `
                    INSERT INTO category_budgets (category_id, month, year, budget_percent)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(category_id, month, year) DO UPDATE SET budget_percent = excluded.budget_percent
                `;
                db.run(upsertLimit, [categoryId, currentMonth, currentYear, percent], (errLimit) => {
                    if (errLimit) console.error('Erro ao atualizar limite', errLimit);
                    getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'updated' });
                    triggerUpdate(familyId);
                    res.json({ message: 'Categoria e limite atualizados' });
                });
            } else {
                getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'updated' });
                triggerUpdate(familyId);
                res.json({ message: 'Categoria atualizada' });
            }
        };

        if (updates.length > 0) {
            params.push(categoryId);
            const query = `UPDATE categories SET ${updates.join(', ')} WHERE id = ? AND family_id = ?`;
            params.push(familyId);
            db.run(query, params, (errUpdate) => {
                if (errUpdate) return res.status(500).json({ error: 'Erro ao atualizar dados básicos' });
                updateCategoryAndLimit();
            });
        } else {
            updateCategoryAndLimit();
        }
    });
};

exports.deleteCategory = (req, res) => {
    const familyId = req.user.family_id;
    const categoryId = req.params.id;

    // Confirma posse ANTES de apagar qualquer coisa — apagar category_budgets primeiro
    // sem checar a família permitiria apagar orçamento de categoria de outra família
    // mesmo que a exclusão da categoria em si fosse bloqueada logo em seguida.
    db.get(`SELECT id FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId], (errCheck, row) => {
        if (errCheck) return res.status(500).json({ error: 'Erro interno no servidor' });
        if (!row) return res.status(404).json({ error: 'Categoria não encontrada' });

        db.run(`DELETE FROM category_budgets WHERE category_id = ?`, [categoryId], (err) => {
            if (err) console.error('Erro ao deletar orçamentos:', err);

            db.run(`DELETE FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId], function(err2) {
                if (err2) {
                    // category_id em transactions/recurring_bills é ON DELETE RESTRICT —
                    // categoria em uso não pode ser excluída; dá pra reconhecer isso pelo
                    // código do erro do MySQL em vez de devolver um 500 genérico.
                    const isInUse = err2.code === 'ER_ROW_IS_REFERENCED_2' || err2.code === 'ER_ROW_IS_REFERENCED' || err2.errno === 1451;
                    if (isInUse) {
                        return res.status(409).json({ error: 'Essa categoria tem transações ou contas fixas vinculadas e não pode ser excluída.' });
                    }
                    return res.status(500).json({ error: 'Erro ao excluir categoria' });
                }
                if (this.changes === 0) return res.status(404).json({ error: 'Categoria não encontrada' });

                getIo().to(`family_${familyId}`).emit('data_updated', { source: 'categories', action: 'deleted' });
                triggerUpdate(familyId);
                res.json({ message: 'Categoria excluída com sucesso' });
            });
        });
    });
};

// Guia 50/30/20 adaptado: até 50% da renda pra NECESSIDADES, até 30% pra
// ESTILO DE VIDA, sempre reservando os 20% restantes de sobra. Classifica a
// categoria pelo NOME (heurística — não tem campo de "essencial" no cadastro).
// Chuta em "wants" por padrão quando não reconhece a palavra, de propósito:
// melhor pecar por sugerir pouco numa categoria que devia ser prioridade do
// que dar 50% de folga a algo que não é necessidade de verdade.
const NEEDS_GROUP_CAP_PERCENT = 50;
const WANTS_GROUP_CAP_PERCENT = 30;
const NEEDS_KEYWORDS = [
    'essencial', 'necess', 'moradia', 'aluguel', 'financiamento',
    'saude', 'saúde', 'medic', 'médic', 'farmac', 'convenio', 'convênio', 'seguro',
    'mercado', 'supermercado', 'alimenta',
    'transporte', 'combustivel', 'combustível',
    'educa', 'escola', 'faculdade',
    'agua', 'água', 'luz', 'energia', 'internet', 'telefone', 'condominio', 'condomínio',
];

function classifyCategoryGroup(name) {
    const normalized = (name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const isNeed = NEEDS_KEYWORDS.some(kw => normalized.includes(
        kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    ));
    return isNeed ? 'NEEDS' : 'WANTS';
}

const suggestionGetQuery = (query, params) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const suggestionGetOne = (query, params) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});

// Sugestão de % ao abrir "Editar Categoria" — cálculo direto (sem chamada de IA
// a cada abertura: instantâneo e sem custo, mas orientado por regra de bolso
// padrão, não por "quanto você já gasta" — já testamos isso e só validava o
// estouro de categorias mal categorizadas tipo "Outros" absorvendo PIX solto).
//
// Regra: cada categoria entra num grupo (NECESSIDADES até 50% da renda, ESTILO
// DE VIDA até 30%), e dentro do grupo o teto é dividido entre as categorias
// ainda sem limite — MAS nunca abaixo do que essa categoria específica já tem
// de conta fixa comprometida (senão a sugestão seria impossível de cumprir:
// de nada adianta sugerir 10% pra uma categoria que já tem 26% em parcela de
// empréstimo vinculada a ela).
exports.getSuggestedCategoryPercent = async (req, res) => {
    const familyId = req.user.family_id;
    const categoryId = parseInt(req.params.id, 10);
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    try {
        const category = await suggestionGetOne(`SELECT id, name, type FROM categories WHERE id = ? AND family_id = ?`, [categoryId, familyId]);
        if (!category) return res.status(404).json({ error: 'Categoria não encontrada' });

        // Só despesa tem sentido de "limite" — receita não tem meta (mesma decisão
        // já tomada quando tiramos a obrigatoriedade de categoria em lançamento de receita).
        if (category.type !== 'EXPENSE') {
            return res.json({ suggestedPercent: 0, reason: 'not_applicable' });
        }

        const incomeRow = await suggestionGetOne(`SELECT COALESCE(SUM(monthly_income), 0) as totalIncome FROM members WHERE family_id = ?`, [familyId]);
        const totalIncome = incomeRow.totalIncome || 0;
        if (totalIncome <= 0) {
            return res.json({ suggestedPercent: 0, reason: 'no_income' });
        }

        // Todas as categorias de despesa da família, com % já configurado e grupo.
        const allCategoriesRaw = await suggestionGetQuery(
            `SELECT c.id, c.name, COALESCE(cb.budget_percent, 0) as percent
             FROM categories c
             LEFT JOIN category_budgets cb ON cb.category_id = c.id AND cb.month = ? AND cb.year = ?
             WHERE c.family_id = ? AND c.type = 'EXPENSE'`,
            [currentMonth, currentYear, familyId]
        );
        const allCategories = allCategoriesRaw.map(c => ({ ...c, group: classifyCategoryGroup(c.name) }));

        // Contas fixas pendentes do mês, por categoria — o "piso" que cada uma já
        // tem comprometido, não importa o grupo/teto (família inteira, mesmo
        // escopo já usado no resto de "Controle por Categoria").
        const { computeExpensesForMonth } = require('./fixedExpensesController');
        const fixedExpenses = await computeExpensesForMonth(familyId, currentMonth, currentYear, null, null);
        const fixedByCategory = {};
        fixedExpenses
            .filter(e => e.status !== 'Pago' && e.categoryId)
            .forEach(e => {
                fixedByCategory[e.categoryId] = (fixedByCategory[e.categoryId] || 0) + (e.amount || 0);
            });
        const floorPercentOf = (catId) => ((fixedByCategory[catId] || 0) / totalIncome) * 100;

        let suggestedPercent = 0;
        let reason = 'ok';

        for (const groupName of ['NEEDS', 'WANTS']) {
            const groupCategories = allCategories.filter(c => c.group === groupName);
            if (!groupCategories.some(c => c.id === categoryId)) continue; // a categoria pedida não é desse grupo

            const groupCap = groupName === 'NEEDS' ? NEEDS_GROUP_CAP_PERCENT : WANTS_GROUP_CAP_PERCENT;
            const alreadySetInGroup = groupCategories.filter(c => c.percent > 0).reduce((s, c) => s + c.percent, 0);
            const unsetInGroup = groupCategories.filter(c => c.percent <= 0);
            const groupRemaining = Math.max(0, groupCap - alreadySetInGroup);

            const floorsSum = unsetInGroup.reduce((s, c) => s + floorPercentOf(c.id), 0);
            const myFloor = floorPercentOf(categoryId);

            if (floorsSum >= groupRemaining) {
                // Só os compromissos já assumidos no grupo já tomam (ou estouram) o teto
                // saudável — a sugestão vira só o piso de cada uma, sem folga extra.
                suggestedPercent = myFloor;
                reason = floorsSum > groupRemaining ? 'floor_exceeds_group_cap' : 'ok';
            } else {
                // Sobra folga além dos pisos — divide o excedente em partes iguais entre
                // as categorias sem limite do grupo, por cima do piso de cada uma.
                const extra = groupRemaining - floorsSum;
                suggestedPercent = myFloor + (extra / unsetInGroup.length);
            }
            break;
        }

        suggestedPercent = Math.min(100, Math.max(0, Math.round(suggestedPercent)));

        res.json({ suggestedPercent, reason });
    } catch (err) {
        console.error('Erro ao calcular sugestão de % de categoria:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

const MONTH_ABBR_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// O último dia útil do mês já pertence ao ciclo da quinzena 1 do mês seguinte
// (é quando cai o salário que financia ela, e é quando um boleto com
// vencimento em fim de semana de fato processa) — não à quinzena 2 do mês
// corrente. Por isso a quinzena 2 "própria" vai só até o PENÚLTIMO dia útil;
// dali pro fim do mês, conta a pagar entra no mês seguinte. Considera só
// fim de semana (sem calendário de feriados nacionais).
function isWeekend(year, month, day) {
    const dow = new Date(year, month - 1, day).getDay();
    return dow === 0 || dow === 6;
}
function lastWeekdayOfMonth(year, month) {
    let d = new Date(year, month, 0).getDate(); // último dia do mês
    while (isWeekend(year, month, d)) d--;
    return d;
}
function secondLastWeekdayOfMonth(year, month) {
    let d = lastWeekdayOfMonth(year, month) - 1;
    while (isWeekend(year, month, d)) d--;
    return d;
}

// Visão mensal por quinzena, seguindo o CICLO real de pagamento, não só o
// calendário cru:
//   - Receitas da quinzena 1 (dia 1-14): entram aqui as receitas lançadas
//     nesse intervalo E o salário que fecha o ciclo (o pagamento perto do fim
//     do mês ANTERIOR, que pode cair no último dia útil antes disso por causa
//     de fim de semana/feriado) — é o mesmo dinheiro que sustenta essas contas,
//     só que caiu um pouco antes da virada do mês. O adiantamento (perto do
//     dia 15) não sofre esse deslocamento: ele já nasce dentro da quinzena que
//     financia, então fica normal na quinzena 2.
//   - Despesas de cada quinzena: despesas soltas lançadas nela + contas a
//     pagar (ainda não pagas) com vencimento nela + contas a pagar não pagas
//     do CICLO anterior (pra quinzena 1, é a quinzena 2 do mês passado; pra
//     quinzena 2, é a quinzena 1 do mesmo mês) — o que não foi resolvido no
//     ciclo dele continua pesando no seguinte até ser pago.
// Reaproveita computeExpensesForMonth (mesma lógica de recorrência/parcelas da
// tela de Contas a Pagar) em vez de reimplementar due_day/parcelas do zero.
exports.getMonthlyOverview = async (req, res) => {
    const familyId = req.user.family_id;
    const familyScope = req.query.scope === 'family';
    const currentUserId = familyScope ? null : req.user.id;
    const monthsCount = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);

    // endMonth/endYear definem o mês mais recente da janela pedida (default: mês
    // atual) — o app pede janelas anteriores ou futuras passando esses dois pra
    // trás/frente, em vez de tudo ficar preso numa janela fixa de 6 meses. Contas
    // fixas se repetem pra sempre e contas com parcela têm data de cada parcela
    // definida, então não tem limite natural nenhum aqui — só o que o app pedir.
    const now = new Date();
    const endMonth = req.query.endMonth ? parseInt(req.query.endMonth, 10) : now.getMonth() + 1;
    const endYear = req.query.endYear ? parseInt(req.query.endYear, 10) : now.getFullYear();

    const targetMonths = [];
    for (let i = monthsCount - 1; i >= 0; i--) {
        const d = new Date(endYear, endMonth - 1 - i, 1);
        targetMonths.push({ month: d.getMonth() + 1, year: d.getFullYear() });
    }

    try {
        const { computeExpensesForMonth } = require('./fixedExpensesController');

        // Perfil de salário/adiantamento do usuário logado — usado só quando falta
        // transação real pro papel específico (adiantamento ou salário), tipicamente
        // em meses futuros. Em scope=family isso não se aplica (não dá pra somar o
        // perfil de todo mundo com segurança sem saber o rateio de cada um).
        let salaryProfile = null;
        if (currentUserId != null) {
            salaryProfile = await suggestionGetOne(
                `SELECT monthly_income, salary_day, advance_day, advance_value FROM members WHERE id = ?`,
                [currentUserId]
            );
        }
        const advanceDay = salaryProfile?.advance_day || null;
        const salaryDay = salaryProfile?.salary_day || null;

        // Decide se um recebimento marcado como salário é o "adiantamento" ou o
        // "salário" que fecha o ciclo, comparando o dia dele com os dois dias
        // configurados no perfil — o mais próximo ganha. Só o segundo sofre o
        // deslocamento pra quinzena 1 do mês seguinte.
        function classifyRole(day) {
            if (advanceDay && salaryDay) {
                return Math.abs(day - advanceDay) <= Math.abs(day - salaryDay) ? 'advance' : 'salary';
            }
            if (advanceDay) return 'advance';
            return 'salary';
        }

        const months = [];
        for (const { month, year } of targetMonths) {
            const monthStr = `${year}-${String(month).padStart(2, '0')}`;
            const prevDate = new Date(year, month - 2, 1);
            const prevMonthStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

            // Contas a pagar (ainda não pagas) dessa competência e da anterior —
            // computeExpensesForMonth já devolve o histórico completo de atrasados
            // até esse mês, cada ocorrência com o referenceMonth original dela, então
            // dá pra pegar o ciclo anterior sem uma segunda chamada.
            const billOccurrences = await computeExpensesForMonth(familyId, month, year, null, currentUserId);
            const unpaidSum = (ref, dueFilter) => billOccurrences
                .filter(e => e.referenceMonth === ref && e.status !== 'Pago' && dueFilter(e.dueDay || 1))
                .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

            const q2Cutoff = secondLastWeekdayOfMonth(year, month);
            const billsQ1Own = unpaidSum(monthStr, d => d <= 14);
            // Só até o penúltimo dia útil é "desta" quinzena 2 — do último dia
            // útil em diante (inclui fim de semana antes dele) já é o próximo
            // ciclo, e entra na quinzena 1 do mês seguinte via carryIntoQ1 de lá.
            const billsQ2Own = unpaidSum(monthStr, d => d > 14 && d <= q2Cutoff);
            const carryIntoQ1 = unpaidSum(prevMonthStr, d => d > 14);
            const carryIntoQ2 = billsQ1Own;
            const billsQ1 = billsQ1Own + carryIntoQ1;
            const billsQ2 = billsQ2Own + carryIntoQ2;

            // Despesas e receitas já lançadas nesse mês, por quinzena. Cartão de
            // crédito fica de fora daqui — não é dinheiro que já saiu da conta,
            // vira dívida que só é cobrada quando a fatura fecha, e essa fatura já
            // entra como conta a pagar (billOccurrences, tipo CREDIT_INVOICE) mais
            // abaixo. Contando os dois, um Uber de R$20 no crédito aparecia como
            // despesa solta JÁ E TAMBÉM dentro da fatura do mês — dobrado.
            const txRows = await suggestionGetQuery(
                `SELECT t.type, t.amount, t.member_id, t.is_salary, DAY(t.transaction_date) as day
                 FROM transactions t
                 JOIN accounts a ON a.id = t.account_id
                 WHERE a.family_id = ? AND t.type IN ('EXPENSE', 'INCOME') AND a.is_credit != 1
                   AND DATE_FORMAT(t.transaction_date, '%Y-%m') = ?`,
                [familyId, monthStr]
            );

            // Cada lado (saídas/receitas) fica separado em duas partes desde já —
            // não só a soma — pra tela poder mostrar a barra dividida: despesas
            // soltas x contas a pagar, salário x demais receitas.
            let expenseQ1 = 0, expenseQ2 = 0, salaryTxQ1 = 0, salaryTxQ2 = 0, otherIncomeQ1 = 0, otherIncomeQ2 = 0;
            let hasAdvanceTx = false, hasSalaryTxOwn = false;
            txRows.forEach(t => {
                if (currentUserId != null && !parseMemberIds(t.member_id).includes(currentUserId)) return;
                const amount = Number(t.amount) || 0;
                const day = t.day || 1;
                const isQ1 = day <= 14;
                if (t.type === 'EXPENSE') {
                    if (isQ1) expenseQ1 += amount; else expenseQ2 += amount;
                } else if (t.type === 'INCOME') {
                    if (t.is_salary) {
                        if (currentUserId != null) {
                            const role = classifyRole(day);
                            if (role === 'advance') {
                                hasAdvanceTx = true;
                                // Adiantamento financia SEMPRE a quinzena 2 (15-fim) do
                                // mesmo mês, mesmo que o dia real de recebimento caia um
                                // pouco antes do dia configurado (fim de semana/feriado
                                // adiantam o depósito) — o que importa é o papel dele no
                                // ciclo, não o dia exato em que caiu.
                                salaryTxQ2 += amount;
                            } else {
                                hasSalaryTxOwn = true;
                                if (isQ1) {
                                    salaryTxQ1 += amount;
                                }
                                // Senão: fecha o ciclo perto do fim do mês — financia a
                                // quinzena 1 do mês SEGUINTE (contado lá via
                                // shiftedInSalary), não a quinzena 2 daqui.
                            }
                        } else {
                            // Family scope sem perfil pra classificar o papel de verdade
                            // — mantém o critério antigo (dia bruto da quinzena).
                            hasAdvanceTx = true;
                            hasSalaryTxOwn = true;
                            if (isQ1) salaryTxQ1 += amount; else salaryTxQ2 += amount;
                        }
                    } else {
                        if (isQ1) otherIncomeQ1 += amount; else otherIncomeQ2 += amount;
                    }
                }
            });

            // Salário do fim do mês ANTERIOR que financia a quinzena 1 deste mês —
            // busca independente de paginação/lote: a data já resolve tudo, não
            // depende do mês anterior ter sido carregado antes neste request.
            let shiftedInSalary = 0;
            let hasRealShiftIn = false;
            if (currentUserId != null) {
                const prevSalaryRows = await suggestionGetQuery(
                    `SELECT t.amount, DAY(t.transaction_date) as day, t.member_id
                     FROM transactions t
                     JOIN accounts a ON a.id = t.account_id
                     WHERE a.family_id = ? AND t.type = 'INCOME' AND t.is_salary = 1
                       AND DATE_FORMAT(t.transaction_date, '%Y-%m') = ?`,
                    [familyId, prevMonthStr]
                );
                prevSalaryRows.forEach(t => {
                    if (!parseMemberIds(t.member_id).includes(currentUserId)) return;
                    const day = t.day || 1;
                    if (day <= 14 || classifyRole(day) !== 'salary') return;
                    shiftedInSalary += Number(t.amount) || 0;
                    hasRealShiftIn = true;
                });
            }

            let salaryQ1 = salaryTxQ1 + shiftedInSalary;
            let salaryQ2 = salaryTxQ2;

            // Projeção pelo perfil só entra quando falta transação real pro papel
            // específico (adiantamento ou salário) — nunca soma em cima do que já
            // foi lançado.
            if (currentUserId != null && salaryProfile && Number(salaryProfile.monthly_income) > 0) {
                const monthlyIncome = Number(salaryProfile.monthly_income) || 0;
                const advanceValue = Number(salaryProfile.advance_value) || 0;
                const hasAdvanceValue = advanceDay && advanceValue > 0;

                if (hasAdvanceValue && !hasAdvanceTx) {
                    if (advanceDay <= 14) salaryQ1 += advanceValue; else salaryQ2 += advanceValue;
                }
                const remainder = hasAdvanceValue ? monthlyIncome - advanceValue : monthlyIncome;
                const remainderDay = salaryDay || advanceDay || 5;
                if (remainderDay <= 14) {
                    if (!hasSalaryTxOwn) salaryQ1 += remainder;
                } else if (!hasRealShiftIn) {
                    // Projeta o salário de fim do mês anterior direto na quinzena 1
                    // deste mês, sem transação lançada ainda pra confirmar.
                    salaryQ1 += remainder;
                }
            }

            months.push({
                month,
                year,
                label: `${MONTH_ABBR_PT[month - 1]}/${year}`,
                quinzenas: [
                    {
                        label: '1-14',
                        saidas: round2(expenseQ1 + billsQ1),
                        despesasSoltas: round2(expenseQ1),
                        contasAPagar: round2(billsQ1),
                        receitas: round2(salaryQ1 + otherIncomeQ1),
                        salario: round2(salaryQ1),
                        outrasReceitas: round2(otherIncomeQ1),
                    },
                    {
                        label: '15-fim',
                        saidas: round2(expenseQ2 + billsQ2),
                        despesasSoltas: round2(expenseQ2),
                        contasAPagar: round2(billsQ2),
                        receitas: round2(salaryQ2 + otherIncomeQ2),
                        salario: round2(salaryQ2),
                        outrasReceitas: round2(otherIncomeQ2),
                    },
                ],
            });
        }

        res.json({ months });
    } catch (err) {
        console.error('Erro ao montar visão mensal:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

// Detalhe de um mês da Visão Mensal: a lista crua de transações e contas a
// pagar que compõem os números das barras, pra debugar visualmente (e editar
// direto, reaproveitando a mesma tela de edição usada no resto do app) em vez
// de confiar cegamente na soma. Cada item já vem marcado com a quinzena em
// que ENTROU na conta (não sempre a quinzena calendário — ver getMonthlyOverview).
exports.getMonthlyOverviewDetail = async (req, res) => {
    const familyId = req.user.family_id;
    const familyScope = req.query.scope === 'family';
    const currentUserId = familyScope ? null : req.user.id;
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);

    if (!month || !year || month < 1 || month > 12) {
        return res.status(400).json({ error: 'month/year inválidos' });
    }

    try {
        const { computeExpensesForMonth } = require('./fixedExpensesController');
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        const prevDate = new Date(year, month - 2, 1);
        const prevMonthStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

        let salaryProfile = null;
        if (currentUserId != null) {
            salaryProfile = await suggestionGetOne(
                `SELECT salary_day, advance_day FROM members WHERE id = ?`,
                [currentUserId]
            );
        }
        const advanceDay = salaryProfile?.advance_day || null;
        const salaryDay = salaryProfile?.salary_day || null;
        function classifyRole(day) {
            if (advanceDay && salaryDay) {
                return Math.abs(day - advanceDay) <= Math.abs(day - salaryDay) ? 'advance' : 'salary';
            }
            if (advanceDay) return 'advance';
            return 'salary';
        }

        // Transações do próprio mês.
        const ownRows = await suggestionGetQuery(
            `SELECT t.id, t.amount, t.type, t.description, t.note, t.transaction_date,
                    t.account_id, t.destination_account_id, t.category_id, t.member_id,
                    t.payment_type, t.recurring_bill_id, t.is_salary,
                    a.name as account_name, c.icon, c.color_hex
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             LEFT JOIN categories c ON c.id = t.category_id
             WHERE a.family_id = ? AND t.type IN ('EXPENSE', 'INCOME') AND a.is_credit != 1
               AND DATE_FORMAT(t.transaction_date, '%Y-%m') = ?
             ORDER BY t.transaction_date ASC, t.id ASC`,
            [familyId, monthStr]
        );

        // Salário do fim do mês anterior, que essa Visão Mensal conta na
        // quinzena 1 daqui — mostrado junto pra fechar a conta visualmente,
        // mesmo sendo de outra competência.
        const shiftedRows = currentUserId != null
            ? await suggestionGetQuery(
                `SELECT t.id, t.amount, t.type, t.description, t.note, t.transaction_date,
                        t.account_id, t.destination_account_id, t.category_id, t.member_id,
                        t.payment_type, t.recurring_bill_id, t.is_salary,
                        a.name as account_name, c.icon, c.color_hex
                 FROM transactions t
                 JOIN accounts a ON a.id = t.account_id
                 LEFT JOIN categories c ON c.id = t.category_id
                 WHERE a.family_id = ? AND t.type = 'INCOME' AND t.is_salary = 1
                   AND DATE_FORMAT(t.transaction_date, '%Y-%m') = ?`,
                [familyId, prevMonthStr]
              )
            : [];

        // Nome de quem lançou, pro card da lista mostrar igual ao resto do
        // app ("Junior", "Andressa"...) em vez do JSON cru de member_id.
        const membersRows = await suggestionGetQuery(`SELECT id, name FROM members WHERE family_id = ?`, [familyId]);
        const resolveMemberName = (memberIdRaw) => {
            const ids = parseMemberIds(memberIdRaw);
            const names = ids
                .map(id => membersRows.find(m => m.id === id)?.name?.split(' ')[0])
                .filter(Boolean);
            return names.join(', ') || 'Desconhecido';
        };

        const transactions = [];
        const addTx = (row, quinzena, tag) => {
            if (currentUserId != null && !parseMemberIds(row.member_id).includes(currentUserId)) return;
            transactions.push({ ...row, member_name: resolveMemberName(row.member_id), quinzena, tag });
        };

        ownRows.forEach(row => {
            const day = new Date(row.transaction_date).getDate();
            const isQ1 = day <= 14;
            if (row.type === 'INCOME' && row.is_salary) {
                const role = currentUserId != null ? classifyRole(day) : (isQ1 ? 'advance' : 'salary');
                if (role === 'advance') {
                    // Adiantamento financia SEMPRE a quinzena 2 do mesmo mês, mesmo
                    // que o dia real caia um pouco antes do configurado — é o papel
                    // dele no ciclo que importa, não o dia exato.
                    addTx(row, 2, 'adiantamento');
                    return;
                }
                if (!isQ1) {
                    // Vai contar na quinzena 1 do mês seguinte, não aqui — ainda assim
                    // mostra nessa lista (é uma transação real deste mês), só marcada.
                    addTx(row, 2, 'salario_desloca_proximo_mes');
                    return;
                }
                addTx(row, 1, 'salario');
                return;
            }
            addTx(row, isQ1 ? 1 : 2, row.type === 'INCOME' ? 'outra_receita' : 'despesa');
        });

        shiftedRows.forEach(row => {
            const day = new Date(row.transaction_date).getDate();
            if (day <= 14 || classifyRole(day) !== 'salary') return;
            addTx(row, 1, 'salario_mes_anterior');
        });

        // Contas a pagar (ainda não pagas) que entram nos totais — não são
        // transações, então aparecem só pra contexto, sem edição por aqui.
        const billOccurrences = await computeExpensesForMonth(familyId, month, year, null, currentUserId);
        const bills = [];
        const addBill = (e, quinzena, tag) => bills.push({
            title: e.title,
            amount: Number(e.amount) || 0,
            dueDay: e.dueDay,
            referenceMonth: e.referenceMonth,
            status: e.status,
            quinzena,
            tag,
        });
        const q2Cutoff = secondLastWeekdayOfMonth(year, month);
        billOccurrences
            .filter(e => e.referenceMonth === monthStr && e.status !== 'Pago')
            .forEach(e => {
                const due = e.dueDay || 1;
                if (due <= 14) return addBill(e, 1, 'propria_quinzena');
                if (due <= q2Cutoff) return addBill(e, 2, 'propria_quinzena');
                // Do último dia útil do mês em diante (inclui fim de semana antes
                // dele) já é o ciclo da quinzena 1 do mês seguinte, não desta.
                addBill(e, 2, 'conta_desloca_proximo_mes');
            });
        billOccurrences
            .filter(e => e.referenceMonth === prevMonthStr && e.status !== 'Pago' && (e.dueDay || 1) > 14)
            .forEach(e => addBill(e, 1, 'atrasada_ciclo_anterior'));
        // Mesma regra pro sentido dentro do mês: o que venceu na quinzena 1 e
        // continua sem pagar também pesa (de novo) na quinzena 2 — por isso
        // aparece aqui duas vezes, uma por quinzena, refletindo a soma real.
        billOccurrences
            .filter(e => e.referenceMonth === monthStr && e.status !== 'Pago' && (e.dueDay || 1) <= 14)
            .forEach(e => addBill(e, 2, 'atrasada_ciclo_anterior'));

        res.json({ month, year, transactions, bills });
    } catch (err) {
        console.error('Erro ao montar detalhe da visão mensal:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
};

function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}


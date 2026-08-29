const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY;
let ai = null;
if (apiKey) {
    ai = new GoogleGenAI({ apiKey });
    console.log('✨ Serviço Gemini Flash-Lite inicializado com sucesso.');
} else {
    console.warn('⚠️ GEMINI_API_KEY não configurada no arquivo .env. Enriquecimento por IA ficará desativado.');
}

// Normaliza um nome de banco/instituição pra comparar com tolerância: minúsculo,
// sem acento, sem pontuação, e sem os termos corporativos que só atrapalham o
// match ("S.A.", "Pagamentos", "Instituição de Pagamento"...). Existe porque o
// nome que aparece num comprovante quase nunca é igual ao nome cadastrado na
// conta (ex: "NU PAGAMENTOS S.A." no comprovante vs "Nubank" cadastrado).
const INSTITUTION_NOISE_TERMS = [
    's a', 'sa', 'ltda', 'me', 'eireli',
    'instituicao de pagamento', 'instituicao financeira', 'instituicao',
    'pagamentos', 'servicos financeiros', 'servicos', 'financeira',
    'banco multiplo', 'banco',
];

// Apelidos conhecidos: o nome oficial de registro de um fintech raramente é o
// nome que a família usaria pra batizar a conta no app.
const INSTITUTION_ALIASES = {
    nu: 'nubank',
    'nu pagamentos': 'nubank',
    'nu financeira': 'nubank',
    picpay: 'picpay',
    mercadopago: 'mercado pago',
    'mercado pago': 'mercado pago',
    'itau unibanco': 'itau',
    'caixa economica federal': 'caixa',
    'santander brasil': 'santander',
    original: 'original',
    c6: 'c6 bank',
    will: 'will bank',
    neon: 'neon',
    stone: 'stone',
    'pagseguro internet': 'pagbank',
};

function normalizeInstitutionName(raw) {
    if (!raw) return '';
    let s = raw
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove acentos (combining diacritics pós NFD)
        .replace(/[^a-z0-9\s]/g, ' '); // remove pontuação
    for (const term of INSTITUTION_NOISE_TERMS) {
        s = s.replace(new RegExp(`\\b${term}\\b`, 'g'), ' ');
    }
    return s.replace(/\s+/g, ' ').trim();
}

function canonicalInstitutionName(raw) {
    const norm = normalizeInstitutionName(raw);
    return INSTITUTION_ALIASES[norm] || norm;
}

// Casa o nome de instituição extraído do comprovante contra as contas
// cadastradas da família. Usa igualdade após normalização, ou "contém" nos dois
// sentidos pra pegar variações tipo "Nubank" dentro de "Banco Nubank S.A.".
// Nomes curtos (<4 chars) ficam de fora do "contém" pra não dar falso positivo
// (ex: "c6" apareceria dentro de qualquer string com essas duas letras juntas).
function findAccountByInstitutionName(accounts, rawName) {
    if (!rawName) return null;
    const target = canonicalInstitutionName(rawName);
    if (!target) return null;
    for (const acc of accounts) {
        const accName = canonicalInstitutionName(acc.name);
        if (!accName) continue;
        if (accName === target) return acc;
        if (accName.length >= 4 && target.length >= 4 && (accName.includes(target) || target.includes(accName))) {
            return acc;
        }
    }
    return null;
}

/**
 * Enriquece e categoriza uma lista de transações brutas usando Gemini Flash-Lite.
 * 
 * @param {number} familyId ID da família do usuário
 * @param {Array} transactions Lista de transações brutas do OFX ou notificações
 * @param {Array} categories Lista de categorias da família
 * @param {Array} accounts Lista de contas bancárias da família
 * @returns {Promise<Array>} Lista de transações enriquecida e corrigida
 */
async function enrichTransactionsWithAI(familyId, transactions, categories, accounts) {
    if (!ai) {
        return transactions;
    }

    try {
        const categoriesList = categories.map(c => ({ id: c.id, name: c.name, type: c.type }));
        const accountsList = accounts.map(a => ({ id: a.id, name: a.name }));

        const systemInstruction = `
Você é um assistente financeiro inteligente especializado em conciliação bancária para o app "Gestão Mob".
Sua tarefa é analisar uma lista de transações bancárias brutas e, para cada uma delas, retornar um objeto estruturado:

1. "description": Título limpo e amigável. Siga estas regras com prioridade:
   - Se o campo "description" já vier limpo (apenas um nome, ex: "Jose Roberto Sanches"), use-o diretamente.
   - Se vier no padrão "Transferência enviada/recebida pelo Pix - NOME - CPF - BANCO...", extraia APENAS o NOME (ex: "Jose Roberto Sanches").
   - Se vier no padrão "Compra no débito - ESTABELECIMENTO", extraia APENAS o nome do estabelecimento (ex: "Supermercado Rossi").
   - Se vier "Aplicação RDB", "Resgate RDB", "IOF" ou outros termos financeiros, mantenha uma versão limpa e legível (ex: "Resgate RDB", "Aplicação RDB").
   - Se vier "NU PAGAMENTOS S/A" como destinatário Pix, use "Nubank" como descrição.
   - NUNCA retorne descrições genéricas como "Transferência Pix", "Pix Enviado" ou "Transação OFX" se houver qualquer nome disponível no campo.
   - Remova CPFs, CNPJs, agências, números de conta, códigos de banco e símbolos "•".

2. "categoryId": O ID numérico da categoria mais correspondente na lista fornecida. Combine exatamente o tipo da transação (INCOME para receitas, EXPENSE para despesas).

3. "shouldCreateAccount": Boolean. Se a transação menciona uma conta ou banco que NÃO está na lista de contas fornecida (ex: notificação do PicPay, mas a conta PicPay não existe na lista), defina como true. Caso contrário, false.

4. "newAccountName": Nome da conta/banco a ser criado se "shouldCreateAccount" for true (ex: "PicPay"). Se false, retorne null.

5. "accountId": O ID numérico da conta correspondente se "shouldCreateAccount" for false.

Importante: Retorne exatamente um array JSON com a mesma quantidade de elementos da lista de entrada, na mesma ordem.
Responda APENAS com a estrutura JSON bruta, sem formatações Markdown (como \`\`\`json) ou textos explicativos.
`;

        const prompt = `
Lista de Categorias Disponíveis:
${JSON.stringify(categoriesList, null, 2)}

Lista de Contas/Carteiras Disponíveis:
${JSON.stringify(accountsList, null, 2)}

Transações brutas para processar:
${JSON.stringify(transactions.map(t => ({
    description: t.description,
    type: t.type,
    amount: t.amount,
    date: t.date
})), null, 2)}
`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite', // Flash-Lite: mesma tarefa (extração/categorização simples) sem o
            // custo de raciocínio do Flash completo — mais rápido e com cota própria, separada do gemini-flash-latest.
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: 'application/json'
            }
        });

        const parsedResults = JSON.parse(response.text.trim());

        return transactions.map((tx, index) => {
            const aiData = parsedResults[index];
            if (aiData) {
                return {
                    ...tx,
                    description: aiData.description || tx.description,
                    categoryId: aiData.categoryId || tx.categoryId,
                    // Dados adicionais para criar conta em segundo plano se necessário
                    aiAccountId: aiData.accountId,
                    aiShouldCreateAccount: aiData.shouldCreateAccount,
                    aiNewAccountName: aiData.newAccountName
                };
            }
            return tx;
        });

    } catch (error) {
        console.error('❌ Erro durante o processamento do Gemini Flash-Lite:', error);
        return transactions;
    }
}

/**
 * Analisa a imagem/PDF de um comprovante e extrai os dados financeiros usando Gemini Flash-Lite.
 * 
 * @param {Buffer} fileBuffer Buffer do arquivo enviado (imagem ou PDF)
 * @param {string} mimeType MimeType do arquivo
 * @param {Array} categories Lista de categorias da família
 * @param {Array} accounts Lista de contas bancárias da família
 * @returns {Promise<Object>} Dados estruturados da transação ou null
 */
async function extractReceiptWithAI(fileBuffer, mimeType, categories, accounts) {
    if (!ai) return null;

    const categoriesList = categories.map(c => ({ id: c.id, name: c.name, type: c.type }));
    // A lista de contas NÃO vai mais pro prompt: a IA deixou de decidir "accountId"
    // sozinha (ver mais abaixo, depois do parse). Ela só extrai o que está na
    // imagem (dígitos do cartão, nome do banco de origem); o casamento contra o
    // cadastro é 100% determinístico aqui no código — dígito bate, ganha; senão
    // nome normalizado; senão fica pra memória do beneficiário resolver no
    // inboxController. Isso fecha a causa raiz de conta duplicada: a IA nunca
    // mais tem autoridade pra criar conta nova por conta própria.
    const currentYear = new Date().getFullYear();
    const systemInstruction = `Você é um assistente financeiro especializado do aplicativo "Gestão Mob".
Sua tarefa é analisar a imagem enviada (que pode ser um comprovante bancário oficial, um PDF, ou um Print/Screenshot da tela do aplicativo do banco mostrando o extrato/transação) e extrair os dados da transação.

Siga esta ordem de prioridade ao analisar a imagem:

PASSO 1 — Identifique primeiro os pontos principais, exatamente nesta ordem:
  a) Os 4 últimos dígitos do cartão usados na transação, se aparecerem na imagem (procure por padrões como "final 4092", "•••• 4092", "**** 4092", "Cartão final 4092"). Em Pix normalmente não existem — nesse caso retorne null.
  b) O nome do banco/instituição DE ORIGEM — de quem é a conta que pagou/recebeu, geralmente a marca/logo do próprio app ou papel que gerou o comprovante. NÃO confunda com o beneficiário do item (d).
  c) A data (e o horário, se visível) real em que a transação ocorreu.
  d) O beneficiário: nome do estabelecimento (para EXPENSE) ou de quem pagou/transferiu (para INCOME).
  e) O valor da transação.
  f) Em transferências Pix: se houver um campo de mensagem/descrição/observação escrito por quem pagou (ex: "aluguel agosto", "rateio mercado"), extraia esse texto também — é diferente do nome do beneficiário.

PASSO 2 — Só depois de ter esses pontos principais, resolva a informação adicional: a categoria mais adequada da lista fornecida.

Não tente decidir a qual conta cadastrada isso pertence, nem sugerir criação de conta — isso é resolvido por outro sistema depois da sua resposta, você só descreve o que está na imagem.

Retorne um objeto JSON estrito com os seguintes campos exatos:
- "cardLastDigits": string com os 4 últimos dígitos do cartão identificados na imagem (ex: "4092"), ou null se não aparecerem (normal em Pix).
- "originInstitutionName": nome do banco/instituição de origem tal como aparece na imagem (ex: "Nu Pagamentos S.A.", "PicPay"), ou null se não for possível identificar.
- "description": Nome limpo e amigável do beneficiário/recebedor (ou de quem pagou, se for INCOME). Remova dados irrelevantes como CNPJ/CPF e instituições intermediárias.
- "note": O texto da mensagem/descrição/observação que a pessoa que pagou escreveu no Pix, se houver (ex: "aluguel agosto"), ou null se não houver nenhuma mensagem visível na imagem.
- "amount": Valor da transação (Número Float, utilize ponto para decimais, não use vírgulas).
- "date": A data real da transação que está impressa no comprovante, estritamente no formato "YYYY-MM-DD". ATENÇÃO: procure pela data em que o pagamento/transferência ocorreu. Se o ano não estiver explícito na imagem, ASSUMA OBRIGATORIAMENTE o ano atual de ${currentYear}. Não invente anos passados.
- "time": Horário da transação no formato "HH:MM" (24h) se estiver visível no comprovante, ou null caso contrário.
- "type": Exatamente "EXPENSE" (se for pagamento, compra, pix enviado) ou "INCOME" (se for recebimento).
- "categoryId": O ID numérico da categoria correspondente da lista fornecida. Combine exatamente o tipo da transação. Se houver dúvida e for despesa, escolha "Outros" ou similar.

Responda APENAS com a estrutura JSON bruta, sem formatações Markdown (como \`\`\`json) ou textos explicativos.`;

    const prompt = `
Lista de Categorias Disponíveis:
${JSON.stringify(categoriesList, null, 2)}
`;

    // Lógica de Retry para lidar com Erros 503 e 429
    let retries = 5; // Aumentado para 5 tentativas
    let delay = 3000;
    
    while (retries > 0) {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.5-flash-lite', // Flash-Lite: mesma tarefa (extração/categorização simples) sem o
            // custo de raciocínio do Flash completo — mais rápido e com cota própria, separada do gemini-flash-latest.
                contents: [
                    prompt,
                    { inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } }
                ],
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: 'application/json'
                }
            });

            const parsed = JSON.parse(response.text.trim());

            // Resolução de conta 100% determinística, fora das mãos da IA — ela só
            // descreveu o que viu na imagem (dígitos, nome do banco). A partir daqui
            // decidimos qual conta cadastrada é essa, em ordem de confiança:
            //   1) 4 últimos dígitos do cartão batendo com uma conta (identidade,
            //      não depende de a IA ter lido o nome do banco corretamente).
            //   2) Nome do banco de origem, normalizado e tolerante a variação
            //      (ex: "NU PAGAMENTOS S.A." casa com conta chamada "Nubank").
            //   3) Nenhum dos dois: accountId fica null. O inboxController ainda
            //      tenta a memória do beneficiário antes de desistir — nunca mais
            //      criamos conta nova sozinhos aqui.
            parsed.accountId = null;
            parsed.accountMatchMethod = 'none';

            if (parsed.cardLastDigits) {
                const digits = String(parsed.cardLastDigits).replace(/\D/g, '').slice(-4);
                if (digits.length === 4) {
                    const matchedByDigits = accounts.find(a =>
                        a.card_last_digits && String(a.card_last_digits).replace(/\D/g, '').slice(-4) === digits
                    );
                    if (matchedByDigits) {
                        parsed.accountId = matchedByDigits.id;
                        parsed.accountMatchMethod = 'digits';
                    }
                }
            }

            if (!parsed.accountId && parsed.originInstitutionName) {
                const matchedByName = findAccountByInstitutionName(accounts, parsed.originInstitutionName);
                if (matchedByName) {
                    parsed.accountId = matchedByName.id;
                    parsed.accountMatchMethod = 'name';
                }
            }

            return parsed;
        } catch (error) {
            console.error(`❌ Erro no Gemini (Tentativas Restantes: ${retries - 1}):`, error.message);
            retries--;
            if (retries === 0) {
                console.error('❌ Falha definitiva após várias tentativas no Gemini.');
                throw error; // Lançar erro para o inboxController salvar o error_message
            }
            
            // Tratamento inteligente para erro 429 (Quota Exceeded)
            let waitTime = delay;
            if (error.message && error.message.includes('429')) {
                const match = error.message.match(/Please retry in (\d+(?:\.\d+)?)s/);
                if (match && match[1]) {
                    const requestedSeconds = parseFloat(match[1]);
                    console.log(`[Background AI] Gemini pediu para aguardar ${requestedSeconds}s. Aguardando...`);
                    waitTime = (requestedSeconds * 1000) + 1000; // Tempo pedido + 1s de margem
                } else {
                    waitTime = 10000; // Fallback de 10s se não encontrar o texto exato
                }
            } else {
                delay += 2000; // Incremento normal para outros erros
            }

            // Espera antes de tentar de novo
            await new Promise(res => setTimeout(res, waitTime));
        }
    }
    return null;
}

module.exports = {
    enrichTransactionsWithAI,
    extractReceiptWithAI
};

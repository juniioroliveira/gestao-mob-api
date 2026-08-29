const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY;
let ai = null;
if (apiKey) {
    ai = new GoogleGenAI({ apiKey });
    console.log('✨ Serviço Gemini Flash-Lite inicializado com sucesso.');
} else {
    console.warn('⚠️ GEMINI_API_KEY não configurada no arquivo .env. Enriquecimento por IA ficará desativado.');
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
    // card_last_digits vai junto pra IA poder casar a conta pelos 4 últimos dígitos
    // do cartão em vez de depender só do nome do banco bater exatamente — nome de
    // banco no comprovante varia demais ("NU PAGAMENTOS" vs "Nubank", "PicPay
    // Cartão" vs "PicPay"...) e isso era o principal motivo de criar conta duplicada.
    const accountsList = accounts.map(a => ({ id: a.id, name: a.name, card_last_digits: a.card_last_digits || null }));

    const currentYear = new Date().getFullYear();
    const systemInstruction = `Você é um assistente financeiro especializado do aplicativo "Gestão Mob".
Sua tarefa é analisar a imagem enviada (que pode ser um comprovante bancário oficial, um PDF, ou um Print/Screenshot da tela do aplicativo do banco mostrando o extrato/transação) e extrair os dados da transação.

Siga esta ordem de prioridade ao analisar a imagem:

PASSO 1 — Identifique primeiro os pontos principais, exatamente nesta ordem:
  a) Os 4 últimos dígitos do cartão/conta usados na transação, se aparecerem na imagem (procure por padrões como "final 4092", "•••• 4092", "**** 4092", "Cartão final 4092").
  b) A data (e o horário, se visível) real em que a transação ocorreu.
  c) O beneficiário: nome do estabelecimento (para EXPENSE) ou de quem pagou/transferiu (para INCOME).
  d) O valor da transação.

PASSO 2 — Só depois de ter esses pontos principais, resolva as informações adicionais: categoria e a conta de origem.

REGRA DE OURO para escolher "accountId" (conta de origem):
- Se você identificou os 4 últimos dígitos do cartão E alguma conta em "Lista de Contas/Carteiras Disponíveis" tem esse mesmo "card_last_digits", USE O ID DESSA CONTA e "shouldCreateAccount": false — mesmo que o nome do banco escrito na imagem seja diferente do nome salvo na conta. Bater os 4 dígitos tem prioridade sobre bater o nome do banco.
- Só recorra ao nome do banco/instituição pra encontrar a conta quando não houver dígitos visíveis na imagem, ou quando nenhuma conta cadastrada tiver esses dígitos.
- Só marque "shouldCreateAccount": true quando NENHUMA conta da lista bater nem pelos dígitos nem pelo nome do banco/instituição.

Retorne um objeto JSON estrito com os seguintes campos exatos:
- "cardLastDigits": string com os 4 últimos dígitos do cartão identificados na imagem (ex: "4092"), ou null se não aparecerem.
- "description": Nome limpo e amigável do estabelecimento ou recebedor. Remova dados irrelevantes como CNPJ/CPF e instituições intermediárias.
- "amount": Valor da transação (Número Float, utilize ponto para decimais, não use vírgulas).
- "date": A data real da transação que está impressa no comprovante, estritamente no formato "YYYY-MM-DD". ATENÇÃO: procure pela data em que o pagamento/transferência ocorreu. Se o ano não estiver explícito na imagem, ASSUMA OBRIGATORIAMENTE o ano atual de ${currentYear}. Não invente anos passados.
- "time": Horário da transação no formato "HH:MM" (24h) se estiver visível no comprovante, ou null caso contrário.
- "type": Exatamente "EXPENSE" (se for pagamento, compra, pix enviado) ou "INCOME" (se for recebimento).
- "categoryId": O ID numérico da categoria correspondente da lista fornecida. Combine exatamente o tipo da transação. Se houver dúvida e for despesa, escolha "Outros" ou similar.
- "accountId": O ID numérico da conta/instituição correspondente da lista, seguindo a REGRA DE OURO acima.
- "shouldCreateAccount": Booleano (true) se nenhuma conta da lista corresponder (nem por dígitos, nem por nome).
- "newAccountName": O nome da instituição (ex: "Nubank") caso shouldCreateAccount seja true.

Responda APENAS com a estrutura JSON bruta, sem formatações Markdown (como \`\`\`json) ou textos explicativos.`;

    const prompt = `
Lista de Categorias Disponíveis:
${JSON.stringify(categoriesList, null, 2)}

Lista de Contas/Carteiras Disponíveis:
${JSON.stringify(accountsList, null, 2)}
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

            // Não confia só no palpite da IA pra "accountId" — se ela leu os 4
            // últimos dígitos do cartão no comprovante, casa direto contra o
            // cadastro aqui no código. Isso garante o match mesmo se a IA errar a
            // resolução da conta (ex: interpretar mal um nome de banco parecido),
            // desde que os dígitos tenham sido lidos corretamente.
            if (parsed && parsed.cardLastDigits) {
                const digits = String(parsed.cardLastDigits).replace(/\D/g, '').slice(-4);
                if (digits.length === 4) {
                    const matchedAccount = accounts.find(a =>
                        a.card_last_digits && String(a.card_last_digits).replace(/\D/g, '').slice(-4) === digits
                    );
                    if (matchedAccount) {
                        parsed.accountId = matchedAccount.id;
                        parsed.shouldCreateAccount = false;
                        parsed.newAccountName = null;
                    }
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

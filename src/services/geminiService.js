const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY;
let ai = null;
if (apiKey) {
    ai = new GoogleGenAI({ apiKey });
    console.log('✨ Serviço Gemini Flash inicializado com sucesso.');
} else {
    console.warn('⚠️ GEMINI_API_KEY não configurada no arquivo .env. Enriquecimento por IA ficará desativado.');
}

/**
 * Enriquece e categoriza uma lista de transações brutas usando Gemini 2.5 Flash.
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
1. "description": Título limpo e amigável da loja, estabelecimento ou recebedor. Remova datas, CNPJs, CPFs, números de agência/conta, e termos como "Transferência enviada pelo Pix", "Compra no débito", etc. (ex: "Compra no débito - ROSSI" -> "Supermercado Rossi", "Transferência enviada pelo Pix - Jose Roberto Sanches ..." -> "José Roberto Sanches").
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
            model: 'gemini-flash-latest',
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
        console.error('❌ Erro durante o processamento do Gemini Flash:', error);
        return transactions;
    }
}

module.exports = {
    enrichTransactionsWithAI
};

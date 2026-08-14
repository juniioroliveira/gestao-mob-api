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

/**
 * Analisa a imagem/PDF de um comprovante e extrai os dados financeiros usando Gemini 2.5 Flash.
 * 
 * @param {Buffer} fileBuffer Buffer do arquivo enviado (imagem ou PDF)
 * @param {string} mimeType MimeType do arquivo
 * @param {Array} categories Lista de categorias da família
 * @param {Array} accounts Lista de contas bancárias da família
 * @returns {Promise<Object>} Dados estruturados da transação ou null
 */
async function extractReceiptWithAI(fileBuffer, mimeType, categories, accounts) {
    if (!ai) return null;
    
    try {
        const categoriesList = categories.map(c => ({ id: c.id, name: c.name, type: c.type }));
        const accountsList = accounts.map(a => ({ id: a.id, name: a.name }));
        
        const systemInstruction = `Você é um assistente financeiro especializado do aplicativo "Gestão Mob".
Sua tarefa é analisar o comprovante bancário (imagem ou PDF) e extrair os dados da transação.
Retorne um objeto JSON estrito com os seguintes campos exatos:
- "description": Nome limpo e amigável do estabelecimento ou recebedor. Remova dados irrelevantes como CNPJ/CPF e instituições intermediárias.
- "amount": Valor da transação (Float, utilize ponto para decimais).
- "date": Data da transação no formato "YYYY-MM-DD".
- "type": "EXPENSE" (se for pagamento, compra, pix enviado) ou "INCOME" (se for recebimento).
- "categoryId": O ID numérico da categoria correspondente da lista fornecida. Combine exatamente o tipo da transação. Se houver dúvida e for despesa, escolha "Outros" ou similar.
- "accountId": O ID numérico da conta/instituição correspondente da lista.
- "shouldCreateAccount": Booleano (true) se a instituição/banco do comprovante não estiver na lista de contas fornecidas.
- "newAccountName": O nome da instituição (ex: "Nubank") caso shouldCreateAccount seja true.

Responda APENAS com a estrutura JSON bruta, sem formatações Markdown (como \`\`\`json) ou textos explicativos.`;

        const prompt = `
Lista de Categorias Disponíveis:
${JSON.stringify(categoriesList, null, 2)}

Lista de Contas/Carteiras Disponíveis:
${JSON.stringify(accountsList, null, 2)}
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                prompt,
                { inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } }
            ],
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: 'application/json'
            }
        });
        
        return JSON.parse(response.text.trim());
    } catch (error) {
        console.error('❌ Erro durante a leitura do comprovante pelo Gemini:', error);
        return null;
    }
}

module.exports = {
    enrichTransactionsWithAI,
    extractReceiptWithAI
};

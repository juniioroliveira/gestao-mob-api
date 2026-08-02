/**
 * Utilitário para parsear arquivos bancários no formato OFX.
 */

/**
 * Pré-processa a descrição bruta do OFX para extrair o nome do destinatário/remetente
 * antes de enviar para a IA. Isso garante que mesmo se a IA falhar, o nome ainda seja preservado.
 * 
 * Padrões tratados (Nubank, C6, Bradesco, Itaú, etc.):
 * - "Transferência enviada pelo Pix - NOME - CPF - BANCO..."
 * - "Transferência recebida pelo Pix - NOME - CPF - BANCO..."
 * - "Pix enviado - NOME"
 * - "TED enviada - NOME - CPF..."
 * - "Compra no débito - NOME DO ESTABELECIMENTO"
 */
function preprocessMemo(memo) {
    if (!memo) return memo;

    // Padrão Nubank: "Transferência enviada/recebida pelo Pix - NOME - CPF/CNPJ - BANCO..."
    const pixTransferMatch = memo.match(/^Transferência (?:enviada|recebida) pelo Pix\s+-\s+(.+?)\s+-\s+[•\d]{3}\./i);
    if (pixTransferMatch) {
        return pixTransferMatch[1].trim();
    }

    // Padrão Nubank: "Compra no débito - NOME" ou "Compra no crédito - NOME"
    const purchaseMatch = memo.match(/^Compra (?:no|a) (?:débito|crédito|prazo)\s+-\s+(.+?)(?:\s+-\s+|$)/i);
    if (purchaseMatch) {
        return purchaseMatch[1].trim();
    }

    // Padrão genérico "Pix enviado - NOME" ou "TED enviada - NOME"
    const genericPixMatch = memo.match(/^(?:Pix|TED|DOC) (?:enviado|enviada|recebido|recebida)\s+-\s+(.+?)(?:\s+-\s+|$)/i);
    if (genericPixMatch) {
        return genericPixMatch[1].trim();
    }

    // Se não bateu em nenhum padrão, retorna o MEMO original (a IA vai tratar)
    return memo;
}

function parseOFX(ofxContent) {
    const transactions = [];
    
    // Divide o arquivo em blocos de transações <STMTTRN>
    const blocks = ofxContent.split(/<STMTTRN>/gi);
    // Remove o cabeçalho inicial antes da primeira transação
    blocks.shift();

    for (const block of blocks) {
        // Função auxiliar para capturar o valor de uma tag, mesmo sem fechamento (padrão SGML)
        const getTagValue = (tag) => {
            const regex = new RegExp(`<${tag}>([^<\\n\\r]+)(?:</${tag}>)?`, 'i');
            const match = block.match(regex);
            return match ? match[1].trim() : null;
        };

        const trnType = getTagValue('TRNTYPE'); // DEBIT, CREDIT, OTHER
        const dateStr = getTagValue('DTPOSTED'); // Formato: YYYYMMDD...
        const amountStr = getTagValue('TRNAMT'); // Formato: -35.00 ou 10.00
        const fitId = getTagValue('FITID'); // ID único da transação
        const rawMemo = getTagValue('MEMO') || getTagValue('NAME') || 'Transação OFX';
        
        // Pré-processa para extrair o nome limpo ainda no parser
        const memo = preprocessMemo(rawMemo);

        if (dateStr && amountStr) {
            // Extrai YYYY-MM-DD da data
            const yyyy = dateStr.substring(0, 4);
            const mm = dateStr.substring(4, 6);
            const dd = dateStr.substring(6, 8);
            const date = `${yyyy}-${mm}-${dd}`;

            const amount = parseFloat(amountStr);

            // Formata a transação para o padrão do Gestão Mob
            transactions.push({
                type: amount < 0 ? 'EXPENSE' : 'INCOME',
                amount: Math.abs(amount),
                date,
                description: memo,
                rawDescription: rawMemo, // Mantém o original para a IA ter contexto adicional
                fitid: fitId
            });
        }
    }
    return transactions;
}

module.exports = {
    parseOFX
};

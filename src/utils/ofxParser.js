/**
 * Utilitário para parsear arquivos bancários no formato OFX.
 */

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
        const memo = getTagValue('MEMO') || getTagValue('NAME') || 'Transação OFX';

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
                fitid: fitId
            });
        }
    }
    return transactions;
}

module.exports = {
    parseOFX
};

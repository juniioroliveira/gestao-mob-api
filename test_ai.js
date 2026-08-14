require('dotenv').config();
const fs = require('fs');
const { extractReceiptWithAI } = require('./src/services/geminiService');

async function runTest() {
    console.log('Iniciando teste da IA...');
    // Imagem Base64 de 1x1 pixel apenas para testar a comunicação com a API
    const dummyImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    
    const fakeCategories = [
        { id: 1, name: 'Alimentação', type: 'EXPENSE' },
        { id: 2, name: 'Salário', type: 'INCOME' }
    ];
    
    const fakeAccounts = [
        { id: 1, name: 'Nubank' }
    ];

    try {
        console.log('Enviando para o Gemini (gemini-flash-latest)...');
        const result = await extractReceiptWithAI(dummyImage, 'image/png', fakeCategories, fakeAccounts);
        console.log('✅ SUCESSO! Resposta do Gemini:');
        console.log(result);
    } catch (e) {
        console.error('❌ ERRO:', e);
    }
}

runTest();

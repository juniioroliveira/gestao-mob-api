const http = require('http');

http.get('http://localhost:5050/api/transactions/health-ai', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log('\n=========================================');
        console.log('🤖 RESPOSTA LOCAL DO HEALTH-AI:');
        console.log('=========================================');
        try {
            console.log(JSON.stringify(JSON.parse(data), null, 2));
        } catch (e) {
            console.log(data);
        }
        console.log('=========================================\n');
    });
}).on('error', (err) => {
    console.error('Erro ao conectar ao servidor local:', err.message);
});

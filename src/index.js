const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { execSync } = require('child_process');
require('dotenv').config();

// Commit que este processo tem carregado em memória, capturado uma única vez na
// subida do servidor — não a cada request. É a resposta pra "o código novo já está
// rodando de verdade aqui?", não só "o arquivo já foi atualizado no disco?": um
// `git pull` sem reiniciar o processo não muda esse valor, do jeito certo.
let CURRENT_COMMIT = 'unknown';
try {
    CURRENT_COMMIT = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
} catch (e) {
    console.warn('⚠️  Não foi possível obter o commit atual via git:', e.message);
}
const SERVER_STARTED_AT = new Date().toISOString();

// Inicializando a Conexão com o Banco (SQLite)
const db = require('./config/database');

// Inicializando o WebSockets
const { initWebSockets } = require('./websockets/socket');

const app = express();
const server = http.createServer(app);

// Middlewares Globais
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Aumentado para suportar imagens base64
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Rotas do Aplicativo 
const testRoutes = require('./routes/testRoutes');
const authRoutes = require('./routes/authRoutes');
const homeRoutes = require('./routes/homeRoutes');
const walletRoutes = require('./routes/walletRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');
const fixedExpensesRoutes = require('./routes/fixedExpensesRoutes');
const profileRoutes = require('./routes/profileRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const memberRoutes = require('./routes/memberRoutes');
const accountRoutes = require('./routes/accountRoutes');
const bankRoutes = require('./routes/bankRoutes');
const documentRoutes = require('./routes/documentRoutes');
const inboxRoutes = require('./routes/inboxRoutes');

// Registrando as Rotas
app.use('/api/test', testRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api/fixed-expenses', fixedExpensesRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/banks', bankRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/inbox', inboxRoutes);

// Configurando o Socket.io passando o servidor HTTP nativo
initWebSockets(server);

// Rotas de Teste (Exemplo REST)
app.get('/', (req, res) => {
    res.status(200).json({
        message: 'Bem-vindo ao Backend da Gestão Mob! 🚀',
        status: 'Online',
        websocket: 'Ativo'
    });
});

// Mesmo espírito do version.json do app Flutter: deixa qualquer um confirmar,
// depois de um deploy, se o commit novo já está de fato rodando aqui — não só
// se já chegou no GitHub ou no disco do servidor.
app.get('/version.json', (req, res) => {
    res.status(200).json({
        commit: CURRENT_COMMIT,
        commit_short: CURRENT_COMMIT === 'unknown' ? 'unknown' : CURRENT_COMMIT.substring(0, 7),
        server_started_at: SERVER_STARTED_AT,
    });
});

app.get('/api/health', (req, res) => {
    // Um simples check do SQLite
    db.get('SELECT 1 as is_alive', (err, row) => {
        if (err) {
            return res.status(500).json({ error: 'Falha no Banco de Dados' });
        }
        res.status(200).json({ status: 'Database OK', data: row });
    });
});

// Ligar o Servidor na porta definida ou 3000
const PORT = process.env.PORT || 5555;

server.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(`🚀 SERVIDOR GESTÃO MOB INICIADO`);
    console.log(`🌐 API REST rodando em: http://localhost:${PORT}`);
    console.log(`📡 WebSockets escutando na mesma porta`);
    console.log(`==============================================\n`);
});
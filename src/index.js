const express = require('express');
const http = require('http');
const cors = require('cors');
require('dotenv').config();

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

// Rotas do Aplicativo
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

// Registrando as Rotas
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
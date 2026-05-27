const mysql = require('mysql2/promise');
const config = require('./src/config/database'); // We can't use db directly, need the pool config
// Actually, let's just connect using the env vars directly
require('dotenv').config();

async function runMigration() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'srv1437.hstgr.io',
        user: process.env.DB_USER || 'u167150707_gestaomob',
        password: process.env.DB_PASSWORD || 'Ti873562',
        database: process.env.DB_NAME || 'u167150707_gestaomob',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    try {
        console.log('Adicionando colunas na tabela accounts...');
        await pool.query("ALTER TABLE accounts ADD COLUMN closing_day INT DEFAULT NULL;");
        await pool.query("ALTER TABLE accounts ADD COLUMN due_day INT DEFAULT NULL;");
        console.log('✅ Colunas closing_day e due_day adicionadas em accounts.');
    } catch (e) {
        if (e.code === 'ER_DUP_FIELDNAME') console.log('⚠️ Colunas já existem em accounts.');
        else console.error('Erro em accounts:', e.message);
    }

    try {
        console.log('Adicionando colunas na tabela transactions...');
        await pool.query("ALTER TABLE transactions ADD COLUMN installment_group_id VARCHAR(50) DEFAULT NULL;");
        await pool.query("ALTER TABLE transactions ADD COLUMN installment_number INT DEFAULT NULL;");
        await pool.query("ALTER TABLE transactions ADD COLUMN total_installments INT DEFAULT NULL;");
        console.log('✅ Colunas de parcelamento adicionadas em transactions.');
    } catch (e) {
        if (e.code === 'ER_DUP_FIELDNAME') console.log('⚠️ Colunas já existem em transactions.');
        else console.error('Erro em transactions:', e.message);
    }

    await pool.end();
}

runMigration();

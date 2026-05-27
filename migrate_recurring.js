const mysql = require('mysql2/promise');
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
        console.log('Adicionando colunas na tabela recurring_bills...');
        await pool.query("ALTER TABLE recurring_bills ADD COLUMN account_id INT DEFAULT NULL;");
        await pool.query("ALTER TABLE recurring_bills ADD COLUMN payment_type VARCHAR(50) DEFAULT NULL;");
        console.log('✅ Colunas account_id e payment_type adicionadas em recurring_bills.');
    } catch (e) {
        if (e.code === 'ER_DUP_FIELDNAME') console.log('⚠️ Colunas já existem em recurring_bills.');
        else console.error('Erro em recurring_bills:', e.message);
    }

    await pool.end();
}

runMigration();

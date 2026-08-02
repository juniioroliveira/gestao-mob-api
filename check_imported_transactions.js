const mysql = require('mysql2');
require('dotenv').config();

const config = {
    host: process.env.DB_HOST || 'srv1437.hstgr.io',
    user: process.env.DB_USER || 'u167150707_gestaomob',
    password: process.env.DB_PASSWORD || 'Ti873562',
    database: process.env.DB_NAME || 'u167150707_gestaomob',
    port: process.env.DB_PORT || 3306
};

const pool = mysql.createPool(config);

pool.query("SELECT id, description, amount, type, transaction_date, is_ai_processed, category_id, fitid FROM transactions ORDER BY id DESC LIMIT 15", (err, results) => {
    if (err) {
        console.error(err);
    } else {
        console.log("\n=========================================");
        console.log("📊 ÚLTIMAS TRANSAÇÕES NO BANCO DE DADOS");
        console.log("=========================================\n");
        console.log(JSON.stringify(results, null, 2));
    }
    pool.end();
});

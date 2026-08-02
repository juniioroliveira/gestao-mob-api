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

pool.query("ALTER TABLE transactions ADD COLUMN fitid VARCHAR(255) DEFAULT NULL", (err, results) => {
    if (err) {
        console.error("Erro ao adicionar coluna fitid:", err);
    } else {
        console.log("Coluna fitid adicionada com sucesso no MySQL!");
        console.log(results);
    }
    pool.end();
});

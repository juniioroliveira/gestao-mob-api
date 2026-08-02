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

const query = `
CREATE TABLE IF NOT EXISTS import_jobs (
  id VARCHAR(50) PRIMARY KEY,
  family_id INT NOT NULL,
  total_transactions INT NOT NULL,
  processed_transactions INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PROCESSING',
  error_message TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

pool.query(query, (err, results) => {
    if (err) {
        console.error("Erro ao criar tabela import_jobs:", err);
    } else {
        console.log("Tabela import_jobs criada com sucesso no MySQL!");
        console.log(results);
    }
    pool.end();
});

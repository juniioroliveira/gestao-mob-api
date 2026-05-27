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

pool.query("SHOW CREATE TABLE categories", (err, results) => {
    if (err) {
        console.error(err);
    } else {
        console.log(results[0]['Create Table']);
    }
    pool.end();
});

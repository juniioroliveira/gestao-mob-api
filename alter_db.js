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

async function alterTable() {
    try {
        // Drop FK
        console.log("Dropping FK...");
        await pool.promise().query("ALTER TABLE recurring_bills DROP FOREIGN KEY recurring_bills_ibfk_2;");
    } catch (e) {
        console.log("FK drop skipped or failed:", e.message);
    }

    try {
        console.log("Altering member_id column...");
        await pool.promise().query("ALTER TABLE recurring_bills MODIFY member_id varchar(512) DEFAULT NULL;");
        console.log("Done!");
    } catch (e) {
        console.log("Alter column failed:", e.message);
    }
    pool.end();
}

alterTable();

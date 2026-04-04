const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.serialize(() => {
    db.all('SELECT * FROM accounts', (err, rows) => {
        console.log('--- ACCOUNTS ---');
        console.table(rows);
    });
    db.all('SELECT * FROM transactions', (err, rows) => {
        console.log('--- TRANSACTIONS ---');
        console.table(rows);
    });
});

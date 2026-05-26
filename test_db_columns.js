const db = require('./src/config/database');

db.all('SHOW COLUMNS FROM accounts', [], (err, rows) => {
    if (err) {
        console.error('Error describing accounts:', err);
    } else {
        console.log('--- ACCOUNTS COLUMNS ---');
        console.table(rows);
    }

    db.all('SHOW COLUMNS FROM transactions', [], (err2, rows2) => {
        if (err2) {
            console.error('Error describing transactions:', err2);
        } else {
            console.log('--- TRANSACTIONS COLUMNS ---');
            console.table(rows2);
        }
        db.close();
    });
});

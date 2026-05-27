const db = require('./src/config/database.js');
db.get("SELECT * FROM members WHERE email = 'junior.oliveira@dephix.com.br'", [], (err, row) => {
    if (err) console.error(err);
    else console.log(row);
    process.exit();
});

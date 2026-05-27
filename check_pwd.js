const bcrypt = require('bcryptjs');
const hash = '$2b$10$jp6QckdPf2pQBJdkYf8G2ekwaIbYfQw2O1EQZSTY3VwYaeU.fAyZO';
const passwords = ['123456', 'password', '12345678', 'admin', 'admin123', 'junior123', 'gestao123'];
passwords.forEach(pwd => {
    if (bcrypt.compareSync(pwd, hash)) {
        console.log('Password is: ' + pwd);
    }
});

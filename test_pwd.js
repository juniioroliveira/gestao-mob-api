const bcrypt = require('bcryptjs');
const hash = '$2b$10$r/nE27DKAxPEc4ltwrgSI.c9/eMdYexr/Qs7hJ0UfLDKOAqNIP5na';
console.log('123', bcrypt.compareSync('123', hash));
console.log('123456', bcrypt.compareSync('123456', hash));

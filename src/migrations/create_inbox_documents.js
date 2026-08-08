const db = require('../config/database');

const query = `
CREATE TABLE IF NOT EXISTS inbox_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    family_id INT NOT NULL,
    member_id INT,
    file_path VARCHAR(512) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(50),
    status VARCHAR(50) DEFAULT 'PENDING',
    extracted_data TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
);
`;

db.run(query, [], function(err) {
    if (err) {
        console.error('Error creating inbox_documents table:', err);
    } else {
        console.log('inbox_documents table created successfully.');
    }
    process.exit(0);
});

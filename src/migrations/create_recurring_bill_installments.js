const db = require('../config/database');

// Parcelas explícitas de uma conta Variável: cada linha tem sua PRÓPRIA data e
// valor, em vez de assumir "um vencimento por mês civil" (due_day). Isso permite
// cadências irregulares (ex: a cada 15 dias) e valores diferentes por parcela.
// Contas Variáveis criadas ANTES desta migração simplesmente não têm linhas aqui
// — o backend cai de volta na geração mensal antiga (due_day/start_date) pra elas.
const query = `
CREATE TABLE IF NOT EXISTS recurring_bill_installments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recurring_bill_id INT NOT NULL,
    installment_number INT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING', -- PENDING | PAID
    transaction_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recurring_bill_id) REFERENCES recurring_bills(id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);
`;

db.run(query, [], function(err) {
    if (err) {
        console.error('Error creating recurring_bill_installments table:', err);
    } else {
        console.log('recurring_bill_installments table created successfully.');
    }
    process.exit(0);
});

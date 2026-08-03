const db = require('../config/database');

async function runMigration() {
    console.log('Starting migration: add_variable_expenses');

    const statements = [
        "ALTER TABLE recurring_bills ADD COLUMN type VARCHAR(20) DEFAULT 'FIXED' NOT NULL;",
        "ALTER TABLE recurring_bills ADD COLUMN total_installments INT DEFAULT NULL;",
        "ALTER TABLE recurring_bills ADD COLUMN current_installment INT DEFAULT 1;",
        "ALTER TABLE recurring_bills ADD COLUMN start_date DATE DEFAULT NULL;",
        "ALTER TABLE recurring_bills ADD COLUMN end_date DATE DEFAULT NULL;"
    ];

    for (const sql of statements) {
        await new Promise((resolve, reject) => {
            db.run(sql, [], function (err) {
                if (err) {
                    console.error(`Error executing: ${sql}`, err.message);
                    resolve(); // Continue even if error (e.g. column already exists)
                } else {
                    console.log(`Success: ${sql}`);
                    resolve();
                }
            });
        });
    }

    console.log('Migration finished.');
}

if (require.main === module) {
    runMigration().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runMigration };

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.serialize(() => {
    // Fix 1: Fatura fechada (Marco) id 34 -> move to account 10
    db.run("UPDATE transactions SET account_id = 10 WHERE id = 34");
    
    // Fix 2: Fatura fechada (Marco) id 11 -> move to account 13
    db.run("UPDATE transactions SET account_id = 13 WHERE id = 11");

    // Fix 3: Fatura Fechada (Marco) id 19 -> move to account 12
    db.run("UPDATE transactions SET account_id = 12 WHERE id = 19");

    // Fix 4: Fatura fechada (Marco) id 21 -> move to account 11
    db.run("UPDATE transactions SET account_id = 11 WHERE id = 21");

    // Now recalculate ALL account balances based on transactions!
    // This is the safest way to ensure balances are 100% correct.
    
    db.all("SELECT id FROM accounts", (err, accounts) => {
        accounts.forEach(acc => {
            // Calculate total expenses on this account
            db.get("SELECT SUM(amount) as total FROM transactions WHERE account_id = ? AND type = 'EXPENSE'", [acc.id], (err, rowExp) => {
                const expenses = rowExp.total || 0;
                
                // Calculate total incomes on this account
                db.get("SELECT SUM(amount) as total FROM transactions WHERE account_id = ? AND type = 'INCOME'", [acc.id], (err, rowInc) => {
                    const incomes = rowInc.total || 0;
                    
                    // Calculate transfers OUT of this account
                    db.get("SELECT SUM(amount) as total FROM transactions WHERE account_id = ? AND type = 'TRANSFER'", [acc.id], (err, rowTransOut) => {
                        const transfersOut = rowTransOut.total || 0;
                        
                        // Calculate transfers IN to this account
                        db.get("SELECT SUM(amount) as total FROM transactions WHERE destination_account_id = ? AND type = 'TRANSFER'", [acc.id], (err, rowTransIn) => {
                            const transfersIn = rowTransIn.total || 0;
                            
                            // The actual balance should be: Incomes - Expenses - TransfersOut + TransfersIn
                            // Wait, if initial balance was 0. Did the user set initial balances?
                            // Let's assume initial balance is 0 for all, as the user stated: "de fato a conta dephix, assim como todas as outras, eu lancei com saldo 0."
                            
                            const newBalance = incomes - expenses - transfersOut + transfersIn;
                            
                            db.run("UPDATE accounts SET current_balance = ? WHERE id = ?", [newBalance, acc.id], () => {
                                console.log(`Account ${acc.id} balance updated to ${newBalance}`);
                            });
                        });
                    });
                });
            });
        });
    });
});

const mysql = require('mysql2');
require('dotenv').config();

const config = {
    host: process.env.DB_HOST || 'srv1437.hstgr.io',
    user: process.env.DB_USER || 'u167150707_gestaomob',
    password: process.env.DB_PASSWORD || 'Ti873562',
    database: process.env.DB_NAME || 'u167150707_gestaomob',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(config);

console.log('✅ Conectado ao banco de dados MySQL Remoto (Hostinger).');

// SQLite to MySQL Compatibility Layer
const db = {
    // Helper to replace SQLite specific syntax to MySQL
    _convertQuery(sql) {
        if (typeof sql !== 'string') return sql;
        let mysqlSql = sql;
        // Convert "INSERT OR IGNORE" to "INSERT IGNORE"
        mysqlSql = mysqlSql.replace(/INSERT\s+OR\s+IGNORE/gi, 'INSERT IGNORE');
        return mysqlSql;
    },

    run(sql, params, callback) {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        const convertedSql = this._convertQuery(sql);
        pool.query(convertedSql, params, (err, results) => {
            if (callback) {
                if (err) {
                    callback(err);
                } else {
                    // In sqlite3, db.run callback has `this` context with `lastID` and `changes`
                    const context = {
                        lastID: results.insertId || null,
                        changes: results.affectedRows || 0
                    };
                    callback.call(context, null);
                }
            }
        });
    },

    get(sql, params, callback) {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        const convertedSql = this._convertQuery(sql);
        pool.query(convertedSql, params, (err, results) => {
            if (callback) {
                if (err) {
                    callback(err, null);
                } else {
                    const row = results && results.length > 0 ? results[0] : null;
                    callback(null, row);
                }
            }
        });
    },

    all(sql, params, callback) {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        const convertedSql = this._convertQuery(sql);
        pool.query(convertedSql, params, (err, results) => {
            if (callback) {
                if (err) {
                    callback(err, null);
                } else {
                    callback(null, results || []);
                }
            }
        });
    },

    serialize(callback) {
        // Just call the callback immediately since MySQL handles queries sequentially fine
        if (callback) callback();
    },

    prepare(sql) {
        const convertedSql = this._convertQuery(sql);
        return {
            run(params, callback) {
                if (typeof params === 'function') {
                    callback = params;
                    params = [];
                }
                pool.query(convertedSql, params, (err, results) => {
                    if (callback) {
                        if (err) callback(err);
                        else {
                            const context = {
                                lastID: results.insertId || null,
                                changes: results.affectedRows || 0
                            };
                            callback.call(context, null);
                        }
                    }
                });
            },
            finalize() {
                // Noop
            }
        };
    },

    close(callback) {
        pool.end((err) => {
            if (callback) callback(err);
        });
    }
};

module.exports = db;
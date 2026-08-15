// Só deixa passar se o usuário autenticado (authMiddleware já rodou antes) for
// admin da família. Usar depois de authenticateToken nas rotas que precisam disso —
// ex: gerenciamento de categorias/limites, hoje restrito a administradores.
module.exports = function requireAdmin(req, res, next) {
    const isAdmin = req.user && (req.user.is_admin === 1 || req.user.is_admin === true);
    if (!isAdmin) {
        return res.status(403).json({ error: 'Apenas administradores da família podem fazer isso.' });
    }
    next();
};

exports.testHeaders = (req, res) => {
    console.log("HEADERS RECEIVED:", req.headers);
    res.status(200).json(req.headers);
};

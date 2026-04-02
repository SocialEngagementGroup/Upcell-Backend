
const verifyToken = async (req, res, next) => {
  // Authentication is temporarily disabled for migration.
  // The user will implement a new authentication system here.
  
  // To simulate an authenticated admin user for dev purposes:
  // req.user = { email: "admin@example.com" }; 
  
  next();
};

module.exports = { verifyToken };

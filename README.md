# Upcell Backend

The backend for the Upcell (Global Traders) platform, providing a RESTful API for product management, order processing, and administrative tasks.

## Tech Stack
- **Server**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **External Services**:
  - **Stripe**: Payment processing
  - **Resend**: Email notifications
  - **Clerk**: Session token verification and role-based access

## Project Structure
- `index.js`: Main entry point and Express application setup.
- `database.js`: MongoDB connection logic.
- `routes/`: Express routers for different functional areas.
- `schema/`: Mongoose models for data entities (Orders, Products, Categories).
- `controllers/`: Business logic for various endpoints.

## API Reference

### Products & Categories
- `GET /catagory`: Get all parent product categories.
- `GET /available-catagories`: Get list of currently available categories.
- `POST /product`: Create a new product variation.
- `GET /product/:id`: Get details for a specific product.
- `GET /searchproducts?search=...`: Search for products by name.

### Orders & Cart
- `POST /cart`: Fetch product details for a list of IDs.
- `GET /admin-orders/:status`: (Admin) Get orders filtered by status.
- `POST /update-order-status`: (Admin) Update status and notify customer.

## Setup & Installation

### Local Development
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the `Backend` directory:
   ```env
   MONGODB_URL=your_mongodb_uri
   CLERK_SECRET_KEY=your_clerk_secret_key
   RESEND_KEY=your_resend_api_key
   TEST_SECRET=your_stripe_test_secret
   TEST_ENDPOINTSECRET=your_stripe_webhook_secret
   PORT=5001
   ```
3. Run the server:
   ```bash
   npm run dev
   ```

### Deployment
Deploy this Express API to the selected backend host and configure the same environment variables there.

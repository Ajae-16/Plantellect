require('dotenv').config();
const mongoose = require('mongoose');

const connectMongoDB = async () => {
    try {
        const uri = process.env.MONGO_URI || 'mongodb://superadmin:plantpassword@localhost:27017/plantellectmongodb?authSource=admin';
        await mongoose.connect(uri);
        console.log('Connected to MongoDB successfully.');
    } catch (error) {
        console.error('MongoDB Connection Error:', error.message);
        process.exit(1);
    }
};

module.exports = connectMongoDB;

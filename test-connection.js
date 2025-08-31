 // test-connection.js - Test your database connection
const mysql = require('mysql2/promise');
require('dotenv').config();

async function testConnection() {
    console.log('🔍 Testing database connection...');
    console.log(`Host: ${process.env.DB_HOST}`);
    console.log(`User: ${process.env.DB_USER}`);
    console.log(`Database: ${process.env.DB_NAME}`);
    
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });
        
        console.log('✅ Database connection successful!');
        
        // Test if tables exist
        const [tables] = await connection.execute(`
            SELECT TABLE_NAME 
            FROM information_schema.TABLES 
            WHERE TABLE_SCHEMA = ? 
            ORDER BY TABLE_NAME
        `, [process.env.DB_NAME]);
        
        console.log('📊 Found tables:');
        tables.forEach(table => {
            console.log(`   - ${table.TABLE_NAME}`);
        });
        
        // Test sample data
        const [players] = await connection.execute('SELECT COUNT(*) as count FROM players');
        const [matches] = await connection.execute('SELECT COUNT(*) as count FROM matches');
        const [archives] = await connection.execute('SELECT COUNT(*) as count FROM monthly_archives');
        
        console.log('📈 Data summary:');
        console.log(`   - Players: ${players[0].count}`);
        console.log(`   - Matches: ${matches[0].count}`);
        console.log(`   - Archives: ${archives[0].count}`);
        
        await connection.end();
        console.log('🎉 Everything looks good!');
        
    } catch (error) {
        console.error('❌ Connection failed:');
        console.error(error.message);
        
        if (error.code === 'ENOTFOUND') {
            console.log('💡 Check your DB_HOST in .env file');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log('💡 Check your DB_USER and DB_PASSWORD in .env file');
        } else if (error.code === 'ER_BAD_DB_ERROR') {
            console.log('💡 Check your DB_NAME - database might not exist');
        }
    }
}

testConnection()
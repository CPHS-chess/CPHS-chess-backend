// test-connection.js - Test your PostgreSQL database connection
const { Pool } = require('pg');
require('dotenv').config();

async function testConnection() {
    console.log('🔍 Testing PostgreSQL database connection...');
    console.log(`Host: ${process.env.DB_HOST || 'localhost'}`);
    console.log(`User: ${process.env.DB_USER || 'postgres'}`);
    console.log(`Database: ${process.env.DB_NAME || 'crown_point_chess_club'}`);
    console.log(`Port: ${process.env.DB_PORT || 5432}`);
    
    const pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        database: process.env.DB_NAME || 'crown_point_chess_club',
        port: process.env.DB_PORT || 5432,
        max: 1, // Only need one connection for testing
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    
    try {
        // Test basic connection
        const client = await pool.connect();
        console.log('✅ Database connection successful!');
        
        // Test if tables exist
        const tablesResult = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `);
        
        console.log('📊 Found tables:');
        tablesResult.rows.forEach(table => {
            console.log(`   - ${table.table_name}`);
        });
        
        // Test views
        const viewsResult = await client.query(`
            SELECT table_name 
            FROM information_schema.views 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        if (viewsResult.rows.length > 0) {
            console.log('👁️  Found views:');
            viewsResult.rows.forEach(view => {
                console.log(`   - ${view.table_name}`);
            });
        }
        
        // Test functions
        const functionsResult = await client.query(`
            SELECT routine_name, routine_type
            FROM information_schema.routines 
            WHERE routine_schema = 'public'
            AND routine_type = 'FUNCTION'
            ORDER BY routine_name
        `);
        
        if (functionsResult.rows.length > 0) {
            console.log('⚙️  Found functions:');
            functionsResult.rows.forEach(func => {
                console.log(`   - ${func.routine_name}()`);
            });
        }
        
        // Test sample data if tables exist
        const expectedTables = ['players', 'matches', 'monthly_archives'];
        const existingTables = tablesResult.rows.map(row => row.table_name);
        const missingTables = expectedTables.filter(table => !existingTables.includes(table));
        
        if (missingTables.length === 0) {
            // All main tables exist, get data counts
            const playersResult = await client.query('SELECT COUNT(*) as count FROM players');
            const matchesResult = await client.query('SELECT COUNT(*) as count FROM matches');
            const archivesResult = await client.query('SELECT COUNT(*) as count FROM monthly_archives');
            
            console.log('📈 Data summary:');
            console.log(`   - Players: ${playersResult.rows[0].count}`);
            console.log(`   - Matches: ${matchesResult.rows[0].count}`);
            console.log(`   - Archives: ${archivesResult.rows[0].count}`);
            
            // Test some sample queries
            console.log('🔍 Testing sample queries...');
            
            // Test leaderboard query
            const leaderboardResult = await client.query(`
                SELECT name, points, tier 
                FROM players 
                ORDER BY points DESC 
                LIMIT 3
            `);
            
            if (leaderboardResult.rows.length > 0) {
                console.log('🏆 Top 3 players:');
                leaderboardResult.rows.forEach((player, index) => {
                    console.log(`   ${index + 1}. ${player.name} - ${player.points} pts (${player.tier})`);
                });
            }
            
            // Test the stored function if it exists
            try {
                const functionTest = await client.query('SELECT get_current_top_3() as top_players');
                console.log('✅ Stored functions working correctly');
            } catch (funcError) {
                console.log('⚠️  Stored function test failed (this might be normal if functions aren\'t created yet)');
            }
            
            // Test views
            try {
                const viewTest = await client.query('SELECT COUNT(*) FROM player_statistics');
                console.log('✅ Views working correctly');
            } catch (viewError) {
                console.log('⚠️  View test failed (this might be normal if views aren\'t created yet)');
            }
            
        } else {
            console.log('⚠️  Missing required tables:');
            missingTables.forEach(table => {
                console.log(`   - ${table}`);
            });
            console.log('💡 Run the schema.sql file to create the required tables');
        }
        
        client.release();
        console.log('🎉 Database test completed successfully!');
        
    } catch (error) {
        console.error('❌ Connection failed:');
        console.error(error.message);
        
        // Provide helpful error messages
        if (error.code === 'ENOTFOUND') {
            console.log('💡 Check your DB_HOST in .env file');
        } else if (error.code === '28P01') {
            console.log('💡 Check your DB_USER and DB_PASSWORD in .env file');
        } else if (error.code === '3D000') {
            console.log('💡 Check your DB_NAME - database might not exist');
            console.log('   You can create it with: CREATE DATABASE crown_point_chess_club;');
        } else if (error.code === 'ECONNREFUSED') {
            console.log('💡 PostgreSQL server might not be running');
            console.log('   Check if PostgreSQL is installed and running on your system');
        } else if (error.code === 'ETIMEDOUT') {
            console.log('💡 Connection timed out - check your DB_HOST and DB_PORT');
        }
        
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Test database performance
async function testPerformance() {
    console.log('\n🚀 Running performance test...');
    
    const pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        database: process.env.DB_NAME || 'crown_point_chess_club',
        port: process.env.DB_PORT || 5432,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    
    try {
        const client = await pool.connect();
        
        // Time a few queries
        const start = Date.now();
        await client.query('SELECT COUNT(*) FROM players');
        const simpleQueryTime = Date.now() - start;
        
        const start2 = Date.now();
        await client.query(`
            SELECT p.name, p.points, p.tier,
                   COALESCE(w.wins, 0) as wins,
                   COALESCE(l.losses, 0) as losses
            FROM players p
            LEFT JOIN (SELECT winner_id, COUNT(*) as wins FROM matches GROUP BY winner_id) w ON p.player_id = w.winner_id
            LEFT JOIN (SELECT loser_id, COUNT(*) as losses FROM matches GROUP BY loser_id) l ON p.player_id = l.loser_id
            ORDER BY p.points DESC
        `);
        const complexQueryTime = Date.now() - start2;
        
        console.log(`⚡ Simple query: ${simpleQueryTime}ms`);
        console.log(`⚡ Complex query: ${complexQueryTime}ms`);
        
        client.release();
    } catch (error) {
        console.log('⚠️  Performance test skipped due to connection issues');
    } finally {
        await pool.end();
    }
}

// Run the tests
async function runTests() {
    await testConnection();
    
    // Only run performance test if basic connection works
    try {
        await testPerformance();
    } catch (error) {
        // Ignore performance test errors
    }
}

runTests().catch(console.error);
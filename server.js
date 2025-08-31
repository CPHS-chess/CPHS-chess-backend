// Crown Point Chess Club - Node.js Backend with PostgreSQL
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files

// PostgreSQL configuration
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'crown_point_chess_club',
    port: process.env.DB_PORT || 5432,
    max: process.env.DB_POOL_MAX || 10,
    idleTimeoutMillis: process.env.DB_POOL_IDLE_TIMEOUT || 30000,
    connectionTimeoutMillis: 2000,
    ssl:true
});

// Test database connection
pool.connect()
    .then(client => {
        console.log('Successfully connected to PostgreSQL database');
        client.release();
    })
    .catch(err => {
        console.error('Error connecting to PostgreSQL database:', err);
    });

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Admin authentication middleware
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Invalid token' });
    }
};

// Utility function for error handling
const handleError = (res, error, message = 'Internal server error') => {
    console.error(message, error);
    res.status(500).json({ 
        success: false, 
        error: message,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
};

// Routes

// Admin login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { password } = req.body;
        
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
        
        if (password === adminPassword) {
            const token = jwt.sign(
                { isAdmin: true, loginTime: Date.now() },
                JWT_SECRET,
                { expiresIn: '8h' }
            );
            
            res.json({ 
                success: true, 
                token,
                message: 'Authentication successful'
            });
        } else {
            res.status(401).json({ 
                success: false, 
                error: 'Invalid password' 
            });
        }
    } catch (error) {
        handleError(res, error, 'Server error during authentication');
    }
});

// === LEADERBOARD ENDPOINTS ===

// Get current leaderboard with all player info
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                p.player_id as id,
                p.name,
                p.points,
                p.tier,
                COALESCE(wins.win_count, 0) as wins,
                COALESCE(losses.loss_count, 0) as losses,
                CASE 
                    WHEN COALESCE(wins.win_count, 0) + COALESCE(losses.loss_count, 0) = 0 THEN 0
                    ELSE ROUND((COALESCE(wins.win_count, 0)::NUMERIC / (COALESCE(wins.win_count, 0) + COALESCE(losses.loss_count, 0))) * 100, 2)
                END as win_percentage,
                CASE WHEN champions.player_id IS NOT NULL THEN true ELSE false END as is_champion,
                CASE WHEN tw.player_id IS NOT NULL THEN true ELSE false END as is_tournament_winner,
                ROW_NUMBER() OVER (ORDER BY p.points DESC, COALESCE(wins.win_count, 0) DESC, p.name ASC) as rank
            FROM players p
            LEFT JOIN (
                SELECT winner_id, COUNT(*) as win_count 
                FROM matches 
                GROUP BY winner_id
            ) wins ON p.player_id = wins.winner_id
            LEFT JOIN (
                SELECT loser_id, COUNT(*) as loss_count 
                FROM matches 
                GROUP BY loser_id  
            ) losses ON p.player_id = losses.loser_id
            LEFT JOIN (
                SELECT DISTINCT unnest(ARRAY[first_place_player_id, second_place_player_id, third_place_player_id]) as player_id
                FROM monthly_archives
            ) champions ON p.player_id = champions.player_id
            LEFT JOIN tournament_winners tw ON p.player_id = tw.player_id
            ORDER BY p.points DESC, COALESCE(wins.win_count, 0) DESC, p.name ASC
        `);
        
        res.json({ success: true, players: result.rows });
    } catch (error) {
        handleError(res, error, 'Failed to fetch leaderboard');
    }
});

// Get top 3 players for podium
app.get('/api/leaderboard/top3', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                p.player_id as id,
                p.name,
                p.points,
                p.tier,
                CASE WHEN champions.player_id IS NOT NULL THEN true ELSE false END as is_champion,
                CASE WHEN tw.player_id IS NOT NULL THEN true ELSE false END as is_tournament_winner,
                ROW_NUMBER() OVER (ORDER BY p.points DESC, p.name ASC) as rank
            FROM players p
            LEFT JOIN (
                SELECT DISTINCT unnest(ARRAY[first_place_player_id, second_place_player_id, third_place_player_id]) as player_id
                FROM monthly_archives
            ) champions ON p.player_id = champions.player_id
            LEFT JOIN tournament_winners tw ON p.player_id = tw.player_id
            ORDER BY p.points DESC, p.name ASC
            LIMIT 3
        `);
        
        res.json({ success: true, top3: result.rows });
    } catch (error) {
        handleError(res, error, 'Failed to fetch top 3');
    }
});

// Get player statistics
app.get('/api/player/:id/stats', async (req, res) => {
    try {
        const playerId = parseInt(req.params.id);
        
        if (isNaN(playerId)) {
            return res.status(400).json({ success: false, error: 'Invalid player ID' });
        }
        
        // Get player basic stats using the view
        const playerResult = await pool.query(`
            SELECT * FROM player_statistics WHERE player_id = $1
        `, [playerId]);
        
        if (playerResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Player not found' });
        }
        
        // Get recent match history
        const historyResult = await pool.query(`
            SELECT 
                CASE 
                    WHEN m.winner_id = $1 THEN 'win'
                    ELSE 'loss'
                END as result,
                CASE 
                    WHEN m.winner_id = $1 THEN lp.name
                    ELSE wp.name
                END as opponent_name,
                CASE 
                    WHEN m.winner_id = $1 THEN m.loser_tier_before
                    ELSE m.winner_tier_before
                END as opponent_tier,
                CASE 
                    WHEN m.winner_id = $1 THEN m.winner_points_change
                    ELSE m.loser_points_change
                END as point_change,
                m.match_date
            FROM matches m
            JOIN players wp ON m.winner_id = wp.player_id
            JOIN players lp ON m.loser_id = lp.player_id
            WHERE m.winner_id = $1 OR m.loser_id = $1
            ORDER BY m.match_date DESC
            LIMIT 20
        `, [playerId]);
        
        const player = playerResult.rows[0];
        
        res.json({ 
            success: true, 
            player: {
                id: player.player_id,
                name: player.name,
                points: player.points,
                tier: player.tier,
                wins: player.wins,
                losses: player.losses,
                total_games: player.total_games,
                win_percentage: player.win_percentage
            },
            matchHistory: historyResult.rows 
        });
    } catch (error) {
        handleError(res, error, 'Failed to fetch player statistics');
    }
});

// === ADMIN PLAYER MANAGEMENT ===

// Add new player (admin only)
app.post('/api/admin/players', authenticateAdmin, async (req, res) => {
    try {
        const { name, email, points = 0 } = req.body;
        
        if (!name || name.trim() === '') {
            return res.status(400).json({ success: false, error: 'Player name is required' });
        }
        
        if (points < 0 || points > 49) {
            return res.status(400).json({ success: false, error: 'Points must be between 0 and 49' });
        }
        
        const result = await pool.query(`
            INSERT INTO players (name, points) 
            VALUES ($1, $2) 
            RETURNING player_id, name, points, tier
        `, [name.trim(), points]);
        
        res.json({ 
            success: true, 
            message: `Player ${name} added successfully!`,
            player: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            res.status(400).json({ success: false, error: 'Player name already exists' });
        } else {
            handleError(res, error, 'Failed to add player');
        }
    }
});

// Get all players for admin dropdowns
app.get('/api/admin/players', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                p.player_id as id,
                p.name,
                p.points,
                p.tier,
                CASE WHEN champions.player_id IS NOT NULL THEN true ELSE false END as is_champion,
                CASE WHEN tw.player_id IS NOT NULL THEN true ELSE false END as is_tournament_winner
            FROM players p
            LEFT JOIN (
                SELECT DISTINCT unnest(ARRAY[first_place_player_id, second_place_player_id, third_place_player_id]) as player_id
                FROM monthly_archives
            ) champions ON p.player_id = champions.player_id
            LEFT JOIN tournament_winners tw ON p.player_id = tw.player_id
            ORDER BY p.name ASC
        `);
        
        res.json({ success: true, players: result.rows });
    } catch (error) {
        handleError(res, error, 'Failed to fetch players');
    }
});

// Remove player (admin only)
app.delete('/api/admin/players/:id', authenticateAdmin, async (req, res) => {
    try {
        const playerId = parseInt(req.params.id);
        
        if (isNaN(playerId)) {
            return res.status(400).json({ success: false, error: 'Invalid player ID' });
        }
        
        const result = await pool.query(`
            DELETE FROM players WHERE player_id = $1 RETURNING name
        `, [playerId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Player not found' });
        }
        
        res.json({ 
            success: true, 
            message: `Player ${result.rows[0].name} removed successfully!` 
        });
    } catch (error) {
        handleError(res, error, 'Failed to remove player');
    }
});

// === MATCH MANAGEMENT ===

// Record match result (admin only)
app.post('/api/admin/matches', authenticateAdmin, async (req, res) => {
    try {
        const { winnerId, loserId, winnerName, loserName } = req.body;
        
        // Support both ID-based and name-based match recording
        let finalWinnerName, finalLoserName;
        
        if (winnerName && loserName) {
            finalWinnerName = winnerName;
            finalLoserName = loserName;
        } else if (winnerId && loserId) {
            // Get names from IDs
            const winnerResult = await pool.query('SELECT name FROM players WHERE player_id = $1', [winnerId]);
            const loserResult = await pool.query('SELECT name FROM players WHERE player_id = $1', [loserId]);
            
            if (winnerResult.rows.length === 0 || loserResult.rows.length === 0) {
                return res.status(400).json({ success: false, error: 'One or both players not found' });
            }
            
            finalWinnerName = winnerResult.rows[0].name;
            finalLoserName = loserResult.rows[0].name;
        } else {
            return res.status(400).json({ 
                success: false, 
                error: 'Either winner/loser names or IDs are required' 
            });
        }
        
        if (finalWinnerName === finalLoserName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Winner and loser cannot be the same player' 
            });
        }
        
        // Use the stored function to record match
        const result = await pool.query(`
            SELECT record_match_result($1, $2) as message
        `, [finalWinnerName, finalLoserName]);
        
        const message = result.rows[0].message;
        
        if (message.startsWith('Error:')) {
            return res.status(400).json({ success: false, error: message });
        }
        
        // Get updated player info for response
        const [winnerInfo, loserInfo] = await Promise.all([
            pool.query('SELECT player_id as id, name, points, tier FROM players WHERE name = $1', [finalWinnerName]),
            pool.query('SELECT player_id as id, name, points, tier FROM players WHERE name = $1', [finalLoserName])
        ]);
        
        res.json({ 
            success: true, 
            message: message,
            winner: winnerInfo.rows[0],
            loser: loserInfo.rows[0]
        });
    } catch (error) {
        handleError(res, error, 'Failed to record match');
    }
});

// Get recent matches for dashboard
app.get('/api/matches/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        
        const result = await pool.query(`
            SELECT * FROM match_history_detailed
            ORDER BY match_date DESC 
            LIMIT $1
        `, [limit]);
        
        res.json({ success: true, matches: result.rows });
    } catch (error) {
        handleError(res, error, 'Failed to fetch recent matches');
    }
});

// === ARCHIVES MANAGEMENT ===

// Get monthly archives
app.get('/api/archives', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                ma.archive_id as id,
                ma.archive_month,
                fp.name as first_place_name,
                ma.first_place_points,
                sp.name as second_place_name,
                ma.second_place_points,
                tp.name as third_place_name,
                ma.third_place_points,
                ma.created_at as archive_date
            FROM monthly_archives ma
            JOIN players fp ON ma.first_place_player_id = fp.player_id
            JOIN players sp ON ma.second_place_player_id = sp.player_id
            JOIN players tp ON ma.third_place_player_id = tp.player_id
            ORDER BY ma.created_at DESC
        `);
        
        res.json({ success: true, archives: result.rows });
    } catch (error) {
        handleError(res, error, 'Failed to fetch archives');
    }
});

// Add monthly archive (admin only)
app.post('/api/admin/archives', authenticateAdmin, async (req, res) => {
    try {
        const { 
            month, 
            firstPlaceId, 
            secondPlaceId, 
            thirdPlaceId 
        } = req.body;
        
        if (!month || !firstPlaceId || !secondPlaceId || !thirdPlaceId) {
            return res.status(400).json({ 
                success: false, 
                error: 'All fields are required' 
            });
        }
        
        // Check for unique winners
        const winners = [firstPlaceId, secondPlaceId, thirdPlaceId];
        if (new Set(winners).size !== winners.length) {
            return res.status(400).json({ 
                success: false, 
                error: 'All three winners must be different players' 
            });
        }
        
        // Get player points
        const playersResult = await pool.query(`
            SELECT player_id, name, points 
            FROM players 
            WHERE player_id = ANY($1)
        `, [winners]);
        
        if (playersResult.rows.length !== 3) {
            return res.status(400).json({ 
                success: false, 
                error: 'One or more players not found' 
            });
        }
        
        const playerMap = {};
        playersResult.rows.forEach(player => {
            playerMap[player.player_id] = player;
        });
        
        await pool.query(`
            INSERT INTO monthly_archives (
                archive_month, 
                first_place_player_id, first_place_points,
                second_place_player_id, second_place_points,
                third_place_player_id, third_place_points
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            month,
            firstPlaceId, playerMap[firstPlaceId].points,
            secondPlaceId, playerMap[secondPlaceId].points,
            thirdPlaceId, playerMap[thirdPlaceId].points
        ]);
        
        res.json({ 
            success: true, 
            message: `Archive for ${month} created successfully!` 
        });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            res.status(400).json({ 
                success: false, 
                error: 'Archive for this month already exists' 
            });
        } else {
            handleError(res, error, 'Failed to create archive');
        }
    }
});

// Delete archive (admin only)
app.delete('/api/admin/archives/:id', authenticateAdmin, async (req, res) => {
    try {
        const archiveId = parseInt(req.params.id);
        
        if (isNaN(archiveId)) {
            return res.status(400).json({ success: false, error: 'Invalid archive ID' });
        }
        
        const result = await pool.query(`
            DELETE FROM monthly_archives WHERE archive_id = $1 RETURNING archive_month
        `, [archiveId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Archive not found' });
        }
        
        res.json({ 
            success: true, 
            message: `Archive for ${result.rows[0].archive_month} deleted successfully!` 
        });
    } catch (error) {
        handleError(res, error, 'Failed to delete archive');
    }
});

// === TOURNAMENT MANAGEMENT ===

// Get tournament winners
app.get('/api/tournament-winners', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                tw.winner_id,
                p.name,
                tw.tournament_name,
                tw.tournament_date
            FROM tournament_winners tw
            JOIN players p ON tw.player_id = p.player_id
            ORDER BY tw.tournament_date DESC
        `);
        
        res.json({ success: true, tournament_winners: result.rows });
    } catch (error) {
        handleError(res, error, 'Failed to fetch tournament winners');
    }
});

// Update tournament winner status (admin only)
app.patch('/api/admin/players/:id/tournament-winner', authenticateAdmin, async (req, res) => {
    try {
        const playerId = parseInt(req.params.id);
        const { isTournamentWinner, tournamentName = 'Tournament' } = req.body;
        
        if (isNaN(playerId)) {
            return res.status(400).json({ success: false, error: 'Invalid player ID' });
        }
        
        if (isTournamentWinner) {
            // Add tournament winner
            await pool.query(`
                INSERT INTO tournament_winners (player_id, tournament_name)
                VALUES ($1, $2)
                ON CONFLICT (player_id, tournament_name, tournament_date) DO NOTHING
            `, [playerId, tournamentName]);
        } else {
            // Remove tournament winner
            await pool.query(`
                DELETE FROM tournament_winners WHERE player_id = $1
            `, [playerId]);
        }
        
        res.json({ 
            success: true, 
            message: 'Tournament winner status updated!' 
        });
    } catch (error) {
        handleError(res, error, 'Failed to update tournament winner status');
    }
});

// Add tournament winner (admin only)
app.post('/api/admin/tournament-winners', authenticateAdmin, async (req, res) => {
    try {
        const { playerId, playerName, tournamentName = 'Tournament' } = req.body;
        
        let finalPlayerId;
        
        if (playerId) {
            finalPlayerId = playerId;
        } else if (playerName) {
            const result = await pool.query('SELECT player_id FROM players WHERE name = $1', [playerName]);
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Player not found' });
            }
            finalPlayerId = result.rows[0].player_id;
        } else {
            return res.status(400).json({ 
                success: false, 
                error: 'Player ID or name is required' 
            });
        }
        
        await pool.query(`
            INSERT INTO tournament_winners (player_id, tournament_name)
            VALUES ($1, $2)
        `, [finalPlayerId, tournamentName]);
        
        res.json({ 
            success: true, 
            message: 'Tournament winner badge added successfully!'
        });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            res.status(400).json({ 
                success: false, 
                error: 'Tournament winner entry already exists' 
            });
        } else {
            handleError(res, error, 'Failed to add tournament winner');
        }
    }
});

// Remove tournament winner (admin only)
app.delete('/api/admin/tournament-winners/:id', authenticateAdmin, async (req, res) => {
    try {
        const playerId = parseInt(req.params.id);
        
        if (isNaN(playerId)) {
            return res.status(400).json({ success: false, error: 'Invalid player ID' });
        }
        
        const result = await pool.query(`
            DELETE FROM tournament_winners 
            WHERE player_id = $1
            RETURNING winner_id
        `, [playerId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Tournament winner not found' 
            });
        }
        
        res.json({ 
            success: true, 
            message: 'Tournament winner badge removed successfully!'
        });
    } catch (error) {
        handleError(res, error, 'Failed to remove tournament winner');
    }
});

// Clear all tournament winners (admin only)
app.delete('/api/admin/tournament-winners', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM tournament_winners');
        
        res.json({ 
            success: true, 
            message: `Cleared ${result.rowCount} tournament winner badges`
        });
    } catch (error) {
        handleError(res, error, 'Failed to clear tournament winners');
    }
});

// === UTILITY ENDPOINTS ===

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as server_time');
        res.json({ 
            success: true,
            status: 'healthy', 
            timestamp: new Date().toISOString(),
            database: 'connected',
            server_time: result.rows[0].server_time
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            status: 'unhealthy',
            database: 'disconnected',
            error: error.message
        });
    }
});

// === ERROR HANDLING ===

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found' 
    });
});

// === GRACEFUL SHUTDOWN ===

const gracefulShutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
        await pool.end();
        console.log('Database connections closed.');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
app.listen(port, () => {
    console.log(`Crown Point Chess Club API running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Health check: http://localhost:${port}/api/health`);
});

module.exports = app;
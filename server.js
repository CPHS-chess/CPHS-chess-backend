 const express = require('express');
const mysql = require('mysql2/promise');
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

// Database configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chess_club',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Admin authentication middleware
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// Routes

// Admin login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { password } = req.body;
        
        // In production, store hashed admin password in database or environment
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
                message: 'Invalid password' 
            });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error during authentication' });
    }
});

// Get current leaderboard
app.get('/api/leaderboard', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                id, name, points, tier, wins, losses,
                CASE 
                    WHEN (wins + losses) = 0 THEN 0 
                    ELSE ROUND((wins / (wins + losses)) * 100, 2) 
                END as win_percentage,
                is_champion, is_tournament_winner,
                ROW_NUMBER() OVER (ORDER BY points DESC, wins DESC, win_percentage DESC) as rank
            FROM players 
            WHERE is_active = TRUE
            ORDER BY points DESC, wins DESC, win_percentage DESC
        `);
        
        res.json({ success: true, players: rows });
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

// Get top 3 players for podium
app.get('/api/leaderboard/top3', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT id, name, points, tier, is_champion, is_tournament_winner
            FROM players 
            WHERE is_active = TRUE
            ORDER BY points DESC, wins DESC 
            LIMIT 3
        `);
        
        res.json({ success: true, top3: rows });
    } catch (error) {
        console.error('Top 3 error:', error);
        res.status(500).json({ error: 'Failed to fetch top 3' });
    }
});

// Get player statistics
app.get('/api/player/:id/stats', async (req, res) => {
    try {
        const playerId = req.params.id;
        
        // Get player basic stats
        const [playerRows] = await pool.execute(
            'SELECT * FROM player_stats WHERE id = ?', 
            [playerId]
        );
        
        if (playerRows.length === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }
        
        // Get recent match history
        const [matchRows] = await pool.execute(`
            SELECT 
                m.match_date,
                CASE 
                    WHEN m.winner_id = ? THEN 'win'
                    ELSE 'loss'
                END as result,
                CASE 
                    WHEN m.winner_id = ? THEN l.name
                    ELSE w.name
                END as opponent_name,
                CASE 
                    WHEN m.winner_id = ? THEN m.loser_tier_before
                    ELSE m.winner_tier_before
                END as opponent_tier,
                CASE 
                    WHEN m.winner_id = ? THEN m.points_exchanged
                    ELSE -m.points_exchanged
                END as point_change
            FROM matches m
            JOIN players w ON m.winner_id = w.id
            JOIN players l ON m.loser_id = l.id
            WHERE m.winner_id = ? OR m.loser_id = ?
            ORDER BY m.match_date DESC
            LIMIT 20
        `, [playerId, playerId, playerId, playerId, playerId, playerId]);
        
        res.json({ 
            success: true, 
            player: playerRows[0],
            matchHistory: matchRows 
        });
    } catch (error) {
        console.error('Player stats error:', error);
        res.status(500).json({ error: 'Failed to fetch player statistics' });
    }
});

// Add new player (admin only)
app.post('/api/admin/players', authenticateAdmin, async (req, res) => {
    try {
        const { name, email, points = 0 } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Player name is required' });
        }
        
        // Use stored procedure to add player
        await pool.execute(
            'CALL AddPlayer(?, ?, ?)',
            [name, email, points]
        );
        
        res.json({ 
            success: true, 
            message: `Player ${name} added successfully!` 
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Player name already exists' });
        }
        console.error('Add player error:', error);
        res.status(500).json({ error: 'Failed to add player' });
    }
});

// Record match result (admin only)
app.post('/api/admin/matches', authenticateAdmin, async (req, res) => {
    try {
        const { winnerId, loserId, pointsExchanged = 1, matchType = 'casual' } = req.body;
        
        if (!winnerId || !loserId) {
            return res.status(400).json({ error: 'Winner and loser IDs are required' });
        }
        
        if (winnerId === loserId) {
            return res.status(400).json({ error: 'Winner and loser cannot be the same player' });
        }
        
        // Use stored procedure to record match
        await pool.execute(
            'CALL RecordMatch(?, ?, ?, ?)',
            [winnerId, loserId, pointsExchanged, matchType]
        );
        
        // Get updated player info for response
        const [winnerRows] = await pool.execute(
            'SELECT name, points, tier FROM players WHERE id = ?',
            [winnerId]
        );
        const [loserRows] = await pool.execute(
            'SELECT name, points, tier FROM players WHERE id = ?',
            [loserId]
        );
        
        res.json({ 
            success: true, 
            message: 'Match recorded successfully!',
            winner: winnerRows[0],
            loser: loserRows[0]
        });
    } catch (error) {
        console.error('Record match error:', error);
        res.status(500).json({ error: 'Failed to record match' });
    }
});

// Get all players for admin dropdowns
app.get('/api/admin/players', authenticateAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT id, name, points, tier, is_champion, is_tournament_winner 
            FROM players 
            WHERE is_active = TRUE
            ORDER BY name ASC
        `);
        
        res.json({ success: true, players: rows });
    } catch (error) {
        console.error('Get players error:', error);
        res.status(500).json({ error: 'Failed to fetch players' });
    }
});

// Remove player (admin only)
app.delete('/api/admin/players/:id', authenticateAdmin, async (req, res) => {
    try {
        const playerId = req.params.id;
        
        // Soft delete - mark as inactive
        const [result] = await pool.execute(
            'UPDATE players SET is_active = FALSE WHERE id = ?',
            [playerId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }
        
        res.json({ 
            success: true, 
            message: 'Player removed successfully!' 
        });
    } catch (error) {
        console.error('Remove player error:', error);
        res.status(500).json({ error: 'Failed to remove player' });
    }
});

// Get monthly archives
app.get('/api/archives', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                ma.id, ma.archive_month, ma.total_players, ma.total_matches,
                p1.name as first_place_name, ma.first_place_points,
                p2.name as second_place_name, ma.second_place_points,
                p3.name as third_place_name, ma.third_place_points,
                ma.archive_date
            FROM monthly_archives ma
            JOIN players p1 ON ma.first_place_player_id = p1.id
            JOIN players p2 ON ma.second_place_player_id = p2.id
            JOIN players p3 ON ma.third_place_player_id = p3.id
            ORDER BY ma.archive_date DESC
        `);
        
        res.json({ success: true, archives: rows });
    } catch (error) {
        console.error('Archives error:', error);
        res.status(500).json({ error: 'Failed to fetch archives' });
    }
});

// Add monthly archive (admin only)
app.post('/api/admin/archives', authenticateAdmin, async (req, res) => {
    try {
        const { 
            month, 
            firstPlaceId, 
            secondPlaceId, 
            thirdPlaceId,
            totalPlayers,
            totalMatches 
        } = req.body;
        
        // Get player points
        const [players] = await pool.execute(
            'SELECT id, points FROM players WHERE id IN (?, ?, ?)',
            [firstPlaceId, secondPlaceId, thirdPlaceId]
        );
        
        const firstPlayer = players.find(p => p.id == firstPlaceId);
        const secondPlayer = players.find(p => p.id == secondPlaceId);
        const thirdPlayer = players.find(p => p.id == thirdPlaceId);
        
        await pool.execute(`
            INSERT INTO monthly_archives 
            (archive_month, first_place_player_id, first_place_points, 
             second_place_player_id, second_place_points, 
             third_place_player_id, third_place_points, 
             total_players, total_matches)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            month, firstPlaceId, firstPlayer.points,
            secondPlaceId, secondPlayer.points,
            thirdPlaceId, thirdPlayer.points,
            totalPlayers || 0, totalMatches || 0
        ]);
        
        // Update champion status for archived players
        await pool.execute(`
            UPDATE players 
            SET is_champion = TRUE 
            WHERE id IN (?, ?, ?)
        `, [firstPlaceId, secondPlaceId, thirdPlaceId]);
        
        res.json({ 
            success: true, 
            message: `Archive for ${month} created successfully!` 
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Archive for this month already exists' });
        }
        console.error('Add archive error:', error);
        res.status(500).json({ error: 'Failed to create archive' });
    }
});

// Delete archive (admin only)
app.delete('/api/admin/archives/:id', authenticateAdmin, async (req, res) => {
    try {
        const archiveId = req.params.id;
        
        const [result] = await pool.execute(
            'DELETE FROM monthly_archives WHERE id = ?',
            [archiveId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Archive not found' });
        }
        
        res.json({ 
            success: true, 
            message: 'Archive deleted successfully!' 
        });
    } catch (error) {
        console.error('Delete archive error:', error);
        res.status(500).json({ error: 'Failed to delete archive' });
    }
});

// Update tournament winner status (admin only)
app.patch('/api/admin/players/:id/tournament-winner', authenticateAdmin, async (req, res) => {
    try {
        const playerId = req.params.id;
        const { isTournamentWinner } = req.body;
        
        await pool.execute(
            'UPDATE players SET is_tournament_winner = ? WHERE id = ?',
            [isTournamentWinner, playerId]
        );
        
        res.json({ 
            success: true, 
            message: 'Tournament winner status updated!' 
        });
    } catch (error) {
        console.error('Update tournament winner error:', error);
        res.status(500).json({ error: 'Failed to update tournament winner status' });
    }
});

// Get recent matches for dashboard
app.get('/api/matches/recent', async (req, res) => {
    try {
        const limit = req.query.limit || 10;
        
        const [rows] = await pool.execute(`
            SELECT * FROM recent_matches 
            ORDER BY match_date DESC 
            LIMIT ?
        `, [parseInt(limit)]);
        
        res.json({ success: true, matches: rows });
    } catch (error) {
        console.error('Recent matches error:', error);
        res.status(500).json({ error: 'Failed to fetch recent matches' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        database: 'connected'
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

// Start server
app.listen(port, () => {
    console.log(`Chess Club API running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

module.exports = app
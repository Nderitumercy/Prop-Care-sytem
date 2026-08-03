const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    } 
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Database connection
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'propcare',
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
        console.log('\n💡 Troubleshooting:');
        console.log('1. Check if PostgreSQL is running');
        console.log('2. Verify .env file has correct password');
        console.log('3. Make sure database "propcare" exists\n');
    } else {
        console.log('✅ Connected to PostgreSQL database');
        release();
        setupDefaultData();
        createAdditionalTables();
    }
});

// File upload setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// ==================== EMAIL CONFIGURATION WITH BREVO ====================
const emailTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER || 'a974f1001@smtp-brevo.com',
        pass: process.env.EMAIL_PASS || 'xsmtpsib-8c6ab6a13eb5440b98e5fbb6c179e5eed5e9f3c4527bc789b1c0b9cd816619da-jV3pUM3vZbilcdWJ'
    },
    tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
    },
    connectionTimeout: 60000,
    greetingTimeout: 60000,
    socketTimeout: 60000
});

// Verify email configuration on startup
emailTransporter.verify((error, success) => {
    if (error) {
        console.error('❌ Email configuration error:', error.message);
        console.error('   Please check your .env file:');
        console.error('   EMAIL_HOST:', process.env.EMAIL_HOST);
        console.error('   EMAIL_PORT:', process.env.EMAIL_PORT);
        console.error('   EMAIL_USER:', process.env.EMAIL_USER);
        console.error('   EMAIL_PASS:', process.env.EMAIL_PASS ? '✓ Set' : '✗ Missing');
        console.error('   ⚠️ Password reset emails will not work until fixed!\n');
    } else {
        console.log('✅ Brevo email service ready!');
        console.log(`📧 Sending emails via: ${process.env.EMAIL_HOST}`);
        console.log(`📧 Using email: ${process.env.EMAIL_USER}\n`);
    }
});

// Verified sender identity used for the 'From' header on all outgoing emails.
// Configure EMAIL_FROM in .env to change it without touching code.
const EMAIL_FROM = '"PropCare System" <' + (process.env.EMAIL_FROM || 'wangarimercy142@gmail.com') + '>';

// Rate limiting for login
const loginAttempts = new Map();

const checkLoginRateLimit = (email, ip) => {
    const key = `${email}:${ip}`;
    const now = Date.now();
    const attempts = loginAttempts.get(key) || [];
    const recentAttempts = attempts.filter(time => now - time < 15 * 60 * 1000);
    
    if (recentAttempts.length >= 5) return false;
    
    recentAttempts.push(now);
    loginAttempts.set(key, recentAttempts);
    return true;
};

// Helper function to parse unit range
function parseUnitRange(range) {
    const units = [];
    const rangeMatch = range.match(/^([A-Za-z]*)(\d+)-([A-Za-z]*)(\d+)$/);
    
    if (rangeMatch) {
        const startPrefix = rangeMatch[1];
        const startNum = parseInt(rangeMatch[2]);
        const endPrefix = rangeMatch[3];
        const endNum = parseInt(rangeMatch[4]);
        
        if (startPrefix === endPrefix && startNum <= endNum) {
            for (let i = startNum; i <= endNum; i++) {
                units.push(`${startPrefix}${i}`);
            }
        }
    }
    return units;
}

// Helper function to escape HTML for email
function escapeHtmlForEmail(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ==================== EMAIL SENDING FUNCTIONS ====================

async function sendEmail(mailOptions) {
    try {
        if (!mailOptions.from) {
            mailOptions.from = EMAIL_FROM;
        }
        
        console.log(`📤 Attempting to send email to: ${mailOptions.to}`);
        console.log(`📧 Subject: ${mailOptions.subject}`);
        
        const info = await emailTransporter.sendMail(mailOptions);
        console.log(`✅ Email sent successfully to: ${mailOptions.to}`);
        console.log(`📧 Message ID: ${info.messageId}`);
        return { success: true, info };
    } catch (err) {
        console.error('❌ Email send error:', err.message);
        if (err.response) {
            console.error('   Response:', err.response);
        }
        return { success: false, error: err };
    }
}

async function sendEmailToLandlord(landlordEmail, landlordName, tenantName, estateName, unitNumber, requestId) {
    try {
        const mailOptions = {
            from: EMAIL_FROM,
            to: landlordEmail,
            subject: '🔔 New Tenant Registration Requires Your Approval',
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #0d3d2b 0%, #1e7a54 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0;">🏠 PropCare</h1>
                        <p style="color: #a8dfc5; margin: 5px 0 0;">Property Management System</p>
                    </div>
                    <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #c8e8d9; border-top: none;">
                        <p style="color: #0d1f18; font-size: 16px; margin-bottom: 20px;">Hello <strong style="color: #1e7a54;">${escapeHtmlForEmail(landlordName)}</strong>,</p>
                        <p style="color: #0d1f18;">A tenant has submitted a registration request for one of your properties.</p>
                        
                        <div style="background: #edfaf3; padding: 20px; border-radius: 10px; margin: 20px 0;">
                            <h3 style="color: #0d3d2b; margin-bottom: 15px;">📋 Registration Details</h3>
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 8px 0; color: #5a7a6b; width: 120px;"><strong>Tenant Name:</strong></td>
                                    <td style="padding: 8px 0; color: #0d1f18;">${escapeHtmlForEmail(tenantName)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #5a7a6b;"><strong>Property:</strong></td>
                                    <td style="padding: 8px 0; color: #0d1f18;">${escapeHtmlForEmail(estateName)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #5a7a6b;"><strong>Unit Number:</strong></td>
                                    <td style="padding: 8px 0; color: #0d1f18;">${escapeHtmlForEmail(unitNumber)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #5a7a6b;"><strong>Request ID:</strong></td>
                                    <td style="padding: 8px 0; color: #0d1f18;">#${requestId}</td>
                                </tr>
                            </table>
                        </div>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="http://localhost:3000/landlord-dashboard.html" style="display: inline-block; padding: 12px 24px; background: #0d3d2b; color: white; text-decoration: none; border-radius: 8px; font-weight: 500;">
                                Go to Dashboard to Review
                            </a>
                        </div>
                        
                        <p style="color: #5a7a6b; font-size: 13px; margin-top: 20px;">
                            ⏰ <strong>Note:</strong> This registration request will expire in 24 hours. Please review it before then.
                        </p>
                        
                        <hr style="border: none; border-top: 1px solid #c8e8d9; margin: 20px 0;">
                        <p style="color: #5a7a6b; font-size: 12px; margin: 0;">
                            Once approved, the tenant will receive login credentials and can start reporting issues.
                        </p>
                    </div>
                    <div style="text-align: center; margin-top: 20px;">
                        <p style="color: #5a7a6b; font-size: 11px;">&copy; ${new Date().getFullYear()} PropCare System. All rights reserved.</p>
                    </div>
                </div>
            `,
            text: `New Tenant Registration Request\n\nHello ${landlordName},\n\nA tenant has submitted a registration request for your property.\n\nDetails:\nTenant: ${tenantName}\nProperty: ${estateName}\nUnit: ${unitNumber}\nRequest ID: #${requestId}\n\nPlease log in to your landlord dashboard to approve or reject this request.\n\nThe request will expire in 24 hours.`
        };
        
        const result = await sendEmail(mailOptions);
        return result.success;
    } catch (err) {
        console.error('Failed to send email to landlord:', err.message);
        return false;
    }
}

async function sendEmailToTenant(tenantEmail, tenantName, estateName, unitNumber, landlordName) {
    try {
        const mailOptions = {
            from: EMAIL_FROM,
            to: tenantEmail,
            subject: '✅ Your PropCare Registration Has Been Approved!',
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #0d3d2b 0%, #1e7a54 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0;">✅ Registration Approved</h1>
                        <p style="color: #a8dfc5; margin: 5px 0 0;">PropCare Property Management</p>
                    </div>
                    <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #c8e8d9; border-top: none;">
                        <p style="color: #0d1f18; font-size: 16px; margin-bottom: 20px;">Hello <strong style="color: #1e7a54;">${escapeHtmlForEmail(tenantName)}</strong>,</p>
                        <p style="color: #0d1f18;">Great news! Your registration request has been <strong style="color: #27ae60;">approved</strong> by your landlord.</p>
                        
                        <div style="background: #e8f5e9; padding: 20px; border-radius: 10px; margin: 20px 0;">
                            <h3 style="color: #0d3d2b; margin-bottom: 15px;">🏠 Your Registered Property</h3>
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 8px 0; color: #5a7a6b; width: 120px;"><strong>Estate:</strong></td>
                                    <td style="padding: 8px 0; color: #0d1f18;">${escapeHtmlForEmail(estateName)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #5a7a6b;"><strong>Unit Number:</strong></td>
                                    <td style="padding: 8px 0; color: #0d1f18;">${escapeHtmlForEmail(unitNumber)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #5a7a6b;"><strong>Landlord:</strong></td>
                                    <td style="padding: 8px 0; color: #0d1f18;">${escapeHtmlForEmail(landlordName)}</td>
                                </tr>
                            </table>
                        </div>
                        
                        <p style="color: #0d1f18;">You can now:</p>
                        <ul style="color: #5a7a6b; margin: 10px 0 20px 20px;">
                            <li>✅ Log in to your tenant dashboard</li>
                            <li>✅ Report maintenance issues</li>
                            <li>✅ Receive updates from your landlord</li>
                            <li>✅ View maintenance schedules</li>
                        </ul>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="http://localhost:3000/" style="display: inline-block; padding: 12px 24px; background: #1e7a54; color: white; text-decoration: none; border-radius: 8px; font-weight: 500;">
                                Login to Your Dashboard
                            </a>
                        </div>
                        
                        <hr style="border: none; border-top: 1px solid #c8e8d9; margin: 20px 0;">
                        <p style="color: #5a7a6b; font-size: 12px; margin: 0;">
                            Use the email you registered with and the password you created during registration.
                        </p>
                    </div>
                    <div style="text-align: center; margin-top: 20px;">
                        <p style="color: #5a7a6b; font-size: 11px;">&copy; ${new Date().getFullYear()} PropCare System. All rights reserved.</p>
                    </div>
                </div>
            `,
            text: `Registration Approved!\n\nHello ${tenantName},\n\nYour registration request has been approved by your landlord.\n\nProperty Details:\nEstate: ${estateName}\nUnit: ${unitNumber}\nLandlord: ${landlordName}\n\nYou can now log in to your tenant dashboard to report issues and receive updates.\n\nLogin at: http://localhost:3000/`
        };
        
        const result = await sendEmail(mailOptions);
        return result.success;
    } catch (err) {
        console.error('Failed to send approval email to tenant:', err.message);
        return false;
    }
}

async function sendRejectionEmailToTenant(tenantEmail, tenantName, estateName, unitNumber) {
    try {
        const mailOptions = {
            from: EMAIL_FROM,
            to: tenantEmail,
            subject: '❌ Your PropCare Registration Request Update',
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #0d3d2b 0%, #1e7a54 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0;">Registration Update</h1>
                    </div>
                    <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #c8e8d9; border-top: none;">
                        <p>Hello <strong>${escapeHtmlForEmail(tenantName)}</strong>,</p>
                        <p>We regret to inform you that your registration request for <strong>${escapeHtmlForEmail(estateName)} Unit ${escapeHtmlForEmail(unitNumber)}</strong> has been <strong style="color: #e74c3c;">rejected</strong> by the landlord.</p>
                        <p>If you believe this is an error, please contact the landlord directly or try registering for a different unit.</p>
                        <hr style="border-top: 1px solid #c8e8d9; margin: 20px 0;">
                        <p style="color: #5a7a6b; font-size: 12px;">If you have any questions, please reach out to your property manager.</p>
                    </div>
                </div>
            `,
            text: `Registration Request Update\n\nHello ${tenantName},\n\nYour registration request for ${estateName} Unit ${unitNumber} has been rejected by the landlord.\n\nPlease contact the landlord directly for more information.`
        };
        
        const result = await sendEmail(mailOptions);
        return result.success;
    } catch (err) {
        console.error('Failed to send rejection email to tenant:', err.message);
        return false;
    }
}

async function createAdditionalTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                reset_code VARCHAR(10) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS maintenance_schedules (
                id SERIAL PRIMARY KEY,
                landlord_id INTEGER REFERENCES users(id),
                title VARCHAR(255) NOT NULL,
                description TEXT,
                scheduled_date TIMESTAMP NOT NULL,
                estimated_duration VARCHAR(100),
                priority VARCHAR(50) DEFAULT 'normal',
                affected_estates TEXT,
                notes TEXT,
                status VARCHAR(50) DEFAULT 'scheduled',
                assigned_technician_id INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        try {
            await pool.query(`ALTER TABLE tenant_registration_requests DROP CONSTRAINT IF EXISTS tenant_registration_requests_email_key`);
            await pool.query(`ALTER TABLE tenant_registration_requests DROP CONSTRAINT IF EXISTS tenant_registration_requests_email_unique`);
            console.log('✅ Removed unique constraint on email from tenant_registration_requests');
        } catch (err) {}
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tenant_registration_requests (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                apartment_id INTEGER REFERENCES apartments(id),
                estate_name VARCHAR(255),
                unit_number VARCHAR(100),
                password_hash VARCHAR(255) NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                expires_at TIMESTAMP NOT NULL,
                landlord_id INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE
        `);
        
        await pool.query(`
            ALTER TABLE maintenance_schedules ADD COLUMN IF NOT EXISTS assigned_technician_id INTEGER REFERENCES users(id) ON DELETE SET NULL
        `);
        
        console.log('✅ Additional tables verified');
    } catch (err) {
        console.error('Error creating tables:', err.message);
    }
}

async function setupDefaultData() {
    try {
        const adminCheck = await pool.query("SELECT id FROM users WHERE email = 'admin@propcare.com'");
        
        if (adminCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await pool.query(
                "INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ($1, $2, $3, $4, $5)",
                ['admin@propcare.com', hashedPassword, 'System Administrator', 'admin', true]
            );
            console.log('✅ Created admin user (email: admin@propcare.com, password: admin123)');
        }
        
        console.log('✅ Server ready!');
    } catch (err) {
        console.error('Setup error:', err.message);
    }
}

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET || 'propcare_secret', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
};

const logAudit = async (userId, action, entityType, entityId, details, ip) => {
    try {
        await pool.query(
            'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, action, entityType, entityId, details, ip]
        );
    } catch (err) {
        console.error('Audit log error:', err);
    }
};

// Socket.io
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('authenticate', (userId) => {
        socket.join(`user_${userId}`);
    });
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Send notification with duplicate prevention
const sendNotification = async (userId, title, message, type, relatedId = null) => {
    try {
        const recentCheck = await pool.query(
            `SELECT id FROM notifications 
             WHERE user_id = $1 AND title = $2 AND type = $3 
             AND created_at > CURRENT_TIMESTAMP - INTERVAL '5 seconds'
             LIMIT 1`,
            [userId, title, type]
        );
        
        if (recentCheck.rows.length > 0) {
            console.log(`Skipping duplicate notification for user ${userId}: ${title}`);
            return recentCheck.rows[0];
        }
        
        const result = await pool.query(
            'INSERT INTO notifications (user_id, title, message, type, related_issue_id, is_read) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [userId, title, message, type, relatedId, false]
        );
        
        io.to(`user_${userId}`).emit('notification', {
            id: result.rows[0].id,
            title,
            message,
            type,
            created_at: new Date()
        });
        
        return result.rows[0];
    } catch (err) {
        console.error('Notification error:', err);
    }
};

// ==================== TEST EMAIL ROUTE ====================

app.post('/api/test-email', async (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email address required' });
    }
    
    try {
        const mailOptions = {
            from: EMAIL_FROM,
            to: email,
            subject: '🧪 PropCare Email Test - Brevo SMTP',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; padding: 20px; border: 1px solid #c8e8d9; border-radius: 10px;">
                    <h2 style="color: #0d3d2b;">✅ Email Test Successful!</h2>
                    <p>This is a test email from your PropCare system using <strong>Brevo</strong> SMTP.</p>
                    <p>If you received this, your email configuration is working correctly.</p>
                    <hr style="border: 1px solid #c8e8d9;">
                    <p style="color: #5a7a6b; font-size: 12px;">Sent at: ${new Date().toLocaleString()}</p>
                    <p style="color: #5a7a6b; font-size: 12px;">SMTP Host: ${process.env.EMAIL_HOST}</p>
                </div>
            `,
            text: `Email Test Successful!\n\nThis is a test email from your PropCare system using Brevo SMTP.\n\nSent at: ${new Date().toLocaleString()}\nSMTP Host: ${process.env.EMAIL_HOST}`
        };
        
        const result = await sendEmail(mailOptions);
        
        if (result.success) {
            res.json({ message: `Test email sent to ${email}`, messageId: result.info.messageId });
        } else {
            throw new Error(result.error.message);
        }
    } catch (err) {
        console.error('❌ Test email error:', err.message);
        res.status(500).json({ error: 'Failed to send test email: ' + err.message });
    }
});

// ==================== AUTHENTICATION ROUTES ====================

app.post('/api/login', async (req, res) => {
    const { email, password, role } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (!email || !password || !role) {
        return res.status(400).json({ error: 'Email, password, and role are required' });
    }
    
    if (!checkLoginRateLimit(email, ip)) {
        return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }
    
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND role = $2 AND is_active = true',
            [email, role]
        );
        
        if (result.rows.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
        
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, name: user.full_name },
            process.env.JWT_SECRET || 'propcare_secret',
            { expiresIn: '24h' }
        );
        
        let additionalData = {};
        
        if (role === 'tenant') {
            const apartmentResult = await pool.query(
                `SELECT a.id, a.estate_name, a.unit_number FROM apartments a 
                 JOIN tenant_apartments ta ON a.id = ta.apartment_id 
                 WHERE ta.tenant_id = $1 AND ta.is_current = true`,
                [user.id]
            );
            additionalData.apartment = apartmentResult.rows[0];
        } else if (role === 'landlord') {
            const apartmentsResult = await pool.query(
                'SELECT id, estate_name, unit_number FROM apartments WHERE landlord_id = $1',
                [user.id]
            );
            additionalData.apartments = apartmentsResult.rows;
            
            const pendingResult = await pool.query(
                'SELECT COUNT(*) FROM tenant_registration_requests WHERE landlord_id = $1 AND status = $2',
                [user.id, 'pending']
            );
            additionalData.pendingRegistrations = parseInt(pendingResult.rows[0].count);
        }
        
        await logAudit(user.id, 'LOGIN_SUCCESS', 'user', user.id, `Logged in as ${role}`, ip);
        
        res.json({
            token,
            user: {
                id: user.id,
                name: user.full_name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                ...additionalData
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// ==================== AVAILABLE APARTMENTS ====================

app.get('/api/available-apartments', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.id, a.estate_name, a.unit_number 
            FROM apartments a
            WHERE a.is_occupied = false 
            AND NOT EXISTS (
                SELECT 1 FROM tenant_registration_requests trr 
                WHERE trr.apartment_id = a.id 
                AND trr.status = 'pending' 
                AND trr.expires_at > CURRENT_TIMESTAMP
            )
            AND NOT EXISTS (
                SELECT 1 FROM tenant_apartments ta 
                WHERE ta.apartment_id = a.id 
                AND ta.is_current = true
            )
            ORDER BY a.estate_name, a.unit_number
        `);
        
        console.log(`📋 Available apartments found: ${result.rows.length}`);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching available apartments:', err);
        res.status(500).json({ error: 'Failed to fetch available apartments' });
    }
});

// ==================== TENANT REGISTRATION ====================

app.post('/api/register/tenant-request', async (req, res) => {
    const { full_name, email, phone, password, estate_name, unit_number } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        const apartmentResult = await pool.query(`
            SELECT a.*, u.id as landlord_id, u.email as landlord_email, u.full_name as landlord_name 
            FROM apartments a
            LEFT JOIN users u ON a.landlord_id = u.id
            WHERE LOWER(a.estate_name) = LOWER($1) 
            AND LOWER(a.unit_number) = LOWER($2) 
            AND a.is_occupied = false
            AND NOT EXISTS (
                SELECT 1 FROM tenant_apartments ta 
                WHERE ta.apartment_id = a.id AND ta.is_current = true
            )
        `, [estate_name, unit_number]);
        
        if (apartmentResult.rows.length === 0) {
            return res.status(400).json({ error: 'Apartment not available - it may be occupied or have an active tenant.' });
        }
        
        const apartment = apartmentResult.rows[0];
        
        if (!apartment.landlord_id) {
            return res.status(400).json({ error: 'This apartment has no assigned landlord. Contact administrator.' });
        }
        
        const existingRequest = await pool.query(
            `SELECT id FROM tenant_registration_requests 
             WHERE apartment_id = $1 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP`,
            [apartment.id]
        );
        
        if (existingRequest.rows.length > 0) {
            return res.status(400).json({ error: 'This unit is pending approval from landlord. Please check back later.' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        const existingPendingRequest = await pool.query(
            `SELECT id FROM tenant_registration_requests 
             WHERE email = $1 AND status = 'pending'`,
            [email]
        );
        
        if (existingPendingRequest.rows.length > 0) {
            return res.status(400).json({ error: 'You already have a pending registration request. Please wait for landlord approval.' });
        }
        
        const existingRejectedRequest = await pool.query(
            `SELECT id FROM tenant_registration_requests 
             WHERE email = $1 AND status = 'rejected'`,
            [email]
        );
        
        if (existingRejectedRequest.rows.length > 0) {
            await pool.query(
                'DELETE FROM tenant_registration_requests WHERE email = $1 AND status = $2',
                [email, 'rejected']
            );
        }
        
        const insertResult = await pool.query(
            `INSERT INTO tenant_registration_requests 
             (full_name, email, phone, apartment_id, estate_name, unit_number, password_hash, expires_at, landlord_id, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [full_name, email, phone, apartment.id, estate_name, unit_number, hashedPassword, expiresAt, apartment.landlord_id, 'pending']
        );
        
        const requestId = insertResult.rows[0].id;
        
        await sendNotification(
            apartment.landlord_id,
            '📋 New Tenant Registration Request',
            `${full_name} wants to register for ${estate_name} Unit ${unit_number}. Please review.`,
            'registration_request',
            apartment.id
        );
        
        if (apartment.landlord_email) {
            await sendEmailToLandlord(
                apartment.landlord_email,
                apartment.landlord_name || 'Landlord',
                full_name,
                estate_name,
                unit_number,
                requestId
            );
        }
        
        res.json({ 
            message: 'Registration request submitted! Your landlord will review your application within 24 hours and receive an email notification.',
            expires_at: expiresAt
        });
    } catch (err) {
        console.error('Registration request error:', err);
        if (err.code === '23505') {
            res.status(400).json({ error: 'A registration request with this email already exists. Please check your email for updates or contact your landlord.' });
        } else {
            res.status(500).json({ error: 'Failed to submit request: ' + err.message });
        }
    }
});

app.get('/api/landlord/registration-requests', authenticateToken, authorize('landlord'), async (req, res) => {
    const landlordId = req.user.id;
    
    try {
        const result = await pool.query(
            `SELECT trr.*, a.estate_name, a.unit_number
             FROM tenant_registration_requests trr
             JOIN apartments a ON trr.apartment_id = a.id
             WHERE trr.landlord_id = $1 AND trr.status = 'pending' AND trr.expires_at > CURRENT_TIMESTAMP
             ORDER BY trr.created_at DESC`,
            [landlordId]
        );
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch registration requests' });
    }
});

// ==================== APPROVE REGISTRATION ====================

app.post('/api/landlord/registration-requests/:id/:action', authenticateToken, authorize('landlord'), async (req, res) => {
    const requestId = parseInt(req.params.id);
    const action = req.params.action;
    const landlordId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (action !== 'approve' && action !== 'reject') {
        return res.status(400).json({ error: 'Invalid action' });
    }
    
    try {
        const requestResult = await pool.query(
            `SELECT trr.*, a.estate_name, a.unit_number, u.full_name as landlord_name, u.email as landlord_email
             FROM tenant_registration_requests trr
             JOIN apartments a ON trr.apartment_id = a.id
             JOIN users u ON trr.landlord_id = u.id
             WHERE trr.id = $1 AND trr.landlord_id = $2 AND trr.status = 'pending' AND trr.expires_at > CURRENT_TIMESTAMP`,
            [requestId, landlordId]
        );
        
        if (requestResult.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found or expired' });
        }
        
        const request = requestResult.rows[0];
        
        if (action === 'approve') {
            const aptCheck = await pool.query(
                'SELECT is_occupied FROM apartments WHERE id = $1',
                [request.apartment_id]
            );
            
            if (aptCheck.rows[0]?.is_occupied === true) {
                return res.status(400).json({ error: 'This apartment is already occupied. Please refresh and try again.' });
            }
            
            // ALWAYS create a NEW user
            const userResult = await pool.query(
                `INSERT INTO users (email, password_hash, full_name, phone, role, is_active) 
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [request.email, request.password_hash, request.full_name, request.phone || '', 'tenant', true]
            );
            
            const tenantId = userResult.rows[0].id;
            
            await pool.query(
                'INSERT INTO tenant_apartments (tenant_id, apartment_id, is_current) VALUES ($1, $2, $3)',
                [tenantId, request.apartment_id, true]
            );
            
            await pool.query('UPDATE apartments SET is_occupied = true WHERE id = $1', [request.apartment_id]);
            
            await pool.query(
                'UPDATE tenant_registration_requests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                ['approved', requestId]
            );
            
            await sendNotification(
                tenantId,
                '✅ Registration Approved!',
                `Your registration for ${request.estate_name} Unit ${request.unit_number} has been approved. You can now login.`,
                'registration_approved'
            );
            
            await sendEmailToTenant(
                request.email,
                request.full_name,
                request.estate_name,
                request.unit_number,
                request.landlord_name
            );
            
            await logAudit(landlordId, 'APPROVE_TENANT', 'user', tenantId, `Approved tenant ${request.full_name} for ${request.estate_name} Unit ${request.unit_number}`, ip);
            
            await sendNotification(
                landlordId,
                'Tenant Approved',
                `${request.full_name} has been approved for ${request.estate_name} Unit ${request.unit_number}.`,
                'tenant_approved'
            );
            
            res.json({ message: 'Tenant registration approved successfully. Email sent to tenant.' });
        } else {
            await pool.query(
                'UPDATE tenant_registration_requests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                ['rejected', requestId]
            );
            
            await sendRejectionEmailToTenant(
                request.email,
                request.full_name,
                request.estate_name,
                request.unit_number
            );
            
            await logAudit(landlordId, 'REJECT_TENANT', 'tenant_registration_request', requestId, `Rejected tenant ${request.full_name}`, ip);
            
            res.json({ message: 'Tenant registration rejected. Email sent to tenant.' });
        }
    } catch (err) {
        console.error('Registration action error:', err);
        if (err.code === '23505') {
            res.status(400).json({ error: 'A user with this email already exists. Please use a different email or contact support.' });
        } else {
            res.status(500).json({ error: 'Failed to process request: ' + err.message });
        }
    }
});

// ==================== APARTMENT MANAGEMENT ====================

app.get('/api/apartments', authenticateToken, async (req, res) => {
    try {
        let query;
        let params;
        
        if (req.user.role === 'landlord') {
            query = `SELECT a.*, CASE WHEN a.is_occupied THEN 'Occupied' ELSE 'Available' END as status
                     FROM apartments a WHERE a.landlord_id = $1 ORDER BY a.estate_name, a.unit_number`;
            params = [req.user.id];
        } else if (req.user.role === 'admin') {
            query = `SELECT a.*, u.full_name as landlord_name,
                     CASE WHEN a.is_occupied THEN 'Occupied' ELSE 'Available' END as status
                     FROM apartments a LEFT JOIN users u ON a.landlord_id = u.id ORDER BY a.estate_name, a.unit_number`;
            params = [];
        } else if (req.user.role === 'tenant') {
            query = `SELECT a.* FROM apartments a
                     JOIN tenant_apartments ta ON a.id = ta.apartment_id
                     WHERE ta.tenant_id = $1 AND ta.is_current = true`;
            params = [req.user.id];
        } else {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch apartments' });
    }
});

app.post('/api/apartments', authenticateToken, authorize('admin'), async (req, res) => {
    const { estate_name, unit_number, landlord_id, unit_range } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (!estate_name) {
        return res.status(400).json({ error: 'Estate name is required' });
    }
    
    try {
        let unitsToAdd = [];
        const inputValue = unit_range || unit_number;
        
        if (inputValue && inputValue.includes('-')) {
            const rangeUnits = parseUnitRange(inputValue);
            if (rangeUnits.length > 0) {
                unitsToAdd = rangeUnits;
            } else {
                return res.status(400).json({ error: 'Invalid range format. Use like: A1-A20 or 1-20' });
            }
        } else if (inputValue) {
            unitsToAdd = [inputValue];
        } else {
            return res.status(400).json({ error: 'Please provide unit number or range' });
        }
        
        let added = 0;
        let failed = 0;
        
        for (const unit of unitsToAdd) {
            const existingCheck = await pool.query(
                'SELECT id FROM apartments WHERE LOWER(estate_name) = LOWER($1) AND LOWER(unit_number) = LOWER($2)',
                [estate_name, unit]
            );
            
            if (existingCheck.rows.length === 0) {
                let finalLandlordId = null;
                if (landlord_id) {
                    const landlordCheck = await pool.query(
                        'SELECT id FROM users WHERE id = $1 AND role = $2',
                        [landlord_id, 'landlord']
                    );
                    if (landlordCheck.rows.length > 0) {
                        finalLandlordId = landlord_id;
                    }
                }
                
                await pool.query(
                    'INSERT INTO apartments (estate_name, unit_number, landlord_id, is_occupied) VALUES ($1, $2, $3, $4)',
                    [estate_name, unit, finalLandlordId, false]
                );
                added++;
            } else {
                failed++;
            }
        }
        
        await logAudit(req.user.id, 'ADD_APARTMENT', 'apartment', null, `Added ${added} units to ${estate_name}`, ip);
        
        res.json({ message: `Added ${added} new apartments, ${failed} already existed`, added, failed });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add apartment: ' + err.message });
    }
});

app.delete('/api/apartments/:id', authenticateToken, authorize('admin'), async (req, res) => {
    const apartmentId = req.params.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        const aptResult = await pool.query(
            'SELECT landlord_id, estate_name, unit_number, is_occupied FROM apartments WHERE id = $1',
            [apartmentId]
        );
        
        if (aptResult.rows.length === 0) {
            return res.status(404).json({ error: 'Apartment not found' });
        }
        
        const apartment = aptResult.rows[0];
        
        const tenantCheck = await pool.query(
            'SELECT COUNT(*) FROM tenant_apartments WHERE apartment_id = $1',
            [apartmentId]
        );
        
        if (parseInt(tenantCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete apartment with active tenants' });
        }
        
        await pool.query('DELETE FROM apartments WHERE id = $1', [apartmentId]);
        
        await logAudit(req.user.id, 'DELETE_APARTMENT', 'apartment', apartmentId, `Deleted ${apartment.estate_name} ${apartment.unit_number}`, ip);
        
        res.json({ message: 'Apartment deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete apartment: ' + err.message });
    }
});

// ==================== LANDLORD TENANT MANAGEMENT (FIXED) ====================

// Helper function to check if an apartment is actually occupied by an active tenant
async function isApartmentOccupied(apartmentId) {
    const result = await pool.query(`
        SELECT COUNT(*) as count 
        FROM tenant_apartments ta
        JOIN users u ON ta.tenant_id = u.id
        WHERE ta.apartment_id = $1 
        AND ta.is_current = true 
        AND u.is_active = true
        AND u.role = 'tenant'
    `, [apartmentId]);
    return parseInt(result.rows[0].count) > 0;
}

// Helper function to get the actual occupancy status
async function getActualOccupancyStatus(apartmentId) {
    const occupied = await isApartmentOccupied(apartmentId);
    // Sync the is_occupied flag with actual status
    await pool.query('UPDATE apartments SET is_occupied = $1 WHERE id = $2', [occupied, apartmentId]);
    return occupied;
}

// Get active tenants
app.get('/api/landlord/tenants', authenticateToken, authorize('landlord'), async (req, res) => {
    const landlordId = req.user.id;
    
    try {
        const result = await pool.query(`
            SELECT u.id, u.full_name, u.email, u.phone, a.estate_name, a.unit_number, u.created_at, u.is_active
            FROM users u
            JOIN tenant_apartments ta ON u.id = ta.tenant_id
            JOIN apartments a ON ta.apartment_id = a.id
            WHERE a.landlord_id = $1 AND u.role = 'tenant' AND u.is_active = true AND ta.is_current = true
            ORDER BY u.created_at DESC
        `, [landlordId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tenants' });
    }
});

// Get removed tenants
app.get('/api/landlord/tenants/removed', authenticateToken, authorize('landlord'), async (req, res) => {
    const landlordId = req.user.id;
    
    try {
        const result = await pool.query(`
            SELECT u.id, u.full_name, u.email, u.phone, a.estate_name, a.unit_number, u.created_at
            FROM users u
            JOIN tenant_apartments ta ON u.id = ta.tenant_id
            JOIN apartments a ON ta.apartment_id = a.id
            WHERE a.landlord_id = $1 AND u.role = 'tenant' AND u.is_active = false
            ORDER BY u.created_at DESC
        `, [landlordId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch removed tenants' });
    }
});

// Remove tenant - FIXED
app.delete('/api/landlord/tenants/:id', authenticateToken, authorize('landlord'), async (req, res) => {
    const tenantId = req.params.id;
    const landlordId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        console.log(`🔍 Removing tenant ID: ${tenantId}`);
        
        const verifyResult = await pool.query(`
            SELECT u.id, u.full_name, u.email, ta.apartment_id, a.estate_name, a.unit_number, a.is_occupied
            FROM users u
            JOIN tenant_apartments ta ON u.id = ta.tenant_id
            JOIN apartments a ON ta.apartment_id = a.id
            WHERE u.id = $1 AND a.landlord_id = $2 AND u.role = 'tenant' AND u.is_active = true
        `, [tenantId, landlordId]);
        
        if (verifyResult.rows.length === 0) {
            return res.status(403).json({ error: 'Active tenant not found under your properties' });
        }
        
        const apartment = verifyResult.rows[0];
        const tenantName = verifyResult.rows[0].full_name;
        const tenantEmail = verifyResult.rows[0].email;
        
        console.log(`📋 Removing: ${tenantName} from ${apartment.estate_name} Unit ${apartment.unit_number}`);
        
        // Soft delete - deactivate user
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [tenantId]);
        
        // Mark tenant_apartments as not current
        await pool.query(
            'UPDATE tenant_apartments SET is_current = false WHERE tenant_id = $1 AND apartment_id = $2',
            [tenantId, apartment.apartment_id]
        );
        
        // Mark apartment as available
        await pool.query('UPDATE apartments SET is_occupied = false WHERE id = $1', [apartment.apartment_id]);
        
        // Remove pending registration requests for this email and apartment
        await pool.query(
            'DELETE FROM tenant_registration_requests WHERE email = $1 AND apartment_id = $2',
            [tenantEmail, apartment.apartment_id]
        );
        
        // Verify the update
        const verifyUpdate = await pool.query(
            'SELECT is_occupied FROM apartments WHERE id = $1',
            [apartment.apartment_id]
        );
        console.log(`✅ Apartment ${apartment.apartment_id} is_occupied = ${verifyUpdate.rows[0]?.is_occupied}`);
        
        await sendNotification(
            tenantId,
            '📋 Account Update',
            `You have been removed from ${apartment.estate_name} Unit ${apartment.unit_number}. You can re-register if you return to this property.`,
            'tenant_removed'
        );
        
        await logAudit(landlordId, 'REMOVE_TENANT', 'user', tenantId, `Removed tenant ${tenantName} from ${apartment.estate_name} ${apartment.unit_number}`, ip);
        
        res.json({ 
            message: `Tenant "${tenantName}" has been removed from ${apartment.estate_name} Unit ${apartment.unit_number}. The apartment is now available.`,
            tenant_removed: true,
            apartment_id: apartment.apartment_id,
            is_occupied: false
        });
    } catch (err) {
        console.error('Remove tenant error:', err);
        res.status(500).json({ error: 'Failed to remove tenant: ' + err.message });
    }
});

// Restore tenant - FIXED with proper occupancy check
app.post('/api/landlord/tenants/:id/restore', authenticateToken, authorize('landlord'), async (req, res) => {
    const tenantId = req.params.id;
    const landlordId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        console.log(`🔍 Restoring tenant ID: ${tenantId}`);
        
        // Get the removed tenant's details
        const verifyResult = await pool.query(`
            SELECT u.id, u.full_name, u.email, ta.apartment_id, a.estate_name, a.unit_number, a.is_occupied
            FROM users u
            JOIN tenant_apartments ta ON u.id = ta.tenant_id
            JOIN apartments a ON ta.apartment_id = a.id
            WHERE u.id = $1 AND a.landlord_id = $2 AND u.role = 'tenant' AND u.is_active = false
        `, [tenantId, landlordId]);
        
        if (verifyResult.rows.length === 0) {
            return res.status(404).json({ error: 'Removed tenant not found' });
        }
        
        const tenant = verifyResult.rows[0];
        console.log(`📋 Tenant: ${tenant.full_name}, Apartment: ${tenant.estate_name} Unit ${tenant.unit_number}`);
        
        // Check if there's an ACTIVE tenant in this apartment (not just the is_occupied flag)
        const activeTenantCheck = await pool.query(`
            SELECT u.id, u.full_name 
            FROM tenant_apartments ta
            JOIN users u ON ta.tenant_id = u.id
            WHERE ta.apartment_id = $1 
            AND ta.is_current = true 
            AND u.is_active = true
            AND u.role = 'tenant'
        `, [tenant.apartment_id]);
        
        if (activeTenantCheck.rows.length > 0) {
            const currentTenant = activeTenantCheck.rows[0];
            console.log(`❌ Apartment ${tenant.estate_name} Unit ${tenant.unit_number} is occupied by ${currentTenant.full_name}`);
            
            // Sync the is_occupied flag
            await pool.query('UPDATE apartments SET is_occupied = true WHERE id = $1', [tenant.apartment_id]);
            
            return res.status(400).json({ 
                error: `Cannot restore "${tenant.full_name}" to ${tenant.estate_name} Unit ${tenant.unit_number} because it is already occupied by ${currentTenant.full_name}.`,
                apartment_occupied: true,
                current_tenant: currentTenant.full_name
            });
        }
        
        // Also check if the is_occupied flag says true (might be out of sync)
        if (tenant.is_occupied === true) {
            // Double-check if there's really a tenant
            const verifyOccupied = await pool.query(`
                SELECT COUNT(*) as count 
                FROM tenant_apartments ta
                JOIN users u ON ta.tenant_id = u.id
                WHERE ta.apartment_id = $1 
                AND ta.is_current = true 
                AND u.is_active = true
                AND u.role = 'tenant'
            `, [tenant.apartment_id]);
            
            if (parseInt(verifyOccupied.rows[0].count) > 0) {
                return res.status(400).json({ 
                    error: `Cannot restore "${tenant.full_name}" to ${tenant.estate_name} Unit ${tenant.unit_number} because it is already occupied.`,
                    apartment_occupied: true
                });
            } else {
                // The flag is wrong, fix it
                await pool.query('UPDATE apartments SET is_occupied = false WHERE id = $1', [tenant.apartment_id]);
                console.log(`✅ Fixed incorrect is_occupied flag for apartment ${tenant.apartment_id}`);
            }
        }
        
        // Reactivate user
        await pool.query('UPDATE users SET is_active = true WHERE id = $1', [tenantId]);
        console.log(`✅ User ${tenantId} reactivated`);
        
        // Mark tenant_apartments as current
        await pool.query(
            'UPDATE tenant_apartments SET is_current = true WHERE tenant_id = $1 AND apartment_id = $2',
            [tenantId, tenant.apartment_id]
        );
        console.log(`✅ Tenant-apartment link updated`);
        
        // Mark apartment as occupied
        await pool.query('UPDATE apartments SET is_occupied = true WHERE id = $1', [tenant.apartment_id]);
        console.log(`✅ Apartment ${tenant.apartment_id} marked as occupied`);
        
        // Verify the update
        const verifyUpdate = await pool.query(
            'SELECT is_occupied FROM apartments WHERE id = $1',
            [tenant.apartment_id]
        );
        console.log(`✅ Verification: Apartment ${tenant.apartment_id} is_occupied = ${verifyUpdate.rows[0]?.is_occupied}`);
        
        await sendNotification(
            tenantId,
            '✅ Account Restored',
            `You have been restored to ${tenant.estate_name} Unit ${tenant.unit_number}. Welcome back!`,
            'tenant_restored'
        );
        
        await logAudit(landlordId, 'RESTORE_TENANT', 'user', tenantId, `Restored tenant ${tenant.full_name} to ${tenant.estate_name} ${tenant.unit_number}`, ip);
        
        res.json({ 
            message: `Tenant "${tenant.full_name}" has been restored to ${tenant.estate_name} Unit ${tenant.unit_number}.`,
            tenant_restored: true,
            apartment_id: tenant.apartment_id,
            is_occupied: true
        });
    } catch (err) {
        console.error('Restore tenant error:', err);
        res.status(500).json({ error: 'Failed to restore tenant: ' + err.message });
    }
});

// Permanently delete tenant
app.delete('/api/landlord/tenants/:id/permanent', authenticateToken, authorize('landlord'), async (req, res) => {
    const tenantId = req.params.id;
    const landlordId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        const verifyResult = await pool.query(`
            SELECT u.id, u.full_name, u.email, ta.apartment_id
            FROM users u
            JOIN tenant_apartments ta ON u.id = ta.tenant_id
            JOIN apartments a ON ta.apartment_id = a.id
            WHERE u.id = $1 AND a.landlord_id = $2 AND u.role = 'tenant' AND u.is_active = false
        `, [tenantId, landlordId]);
        
        if (verifyResult.rows.length === 0) {
            return res.status(404).json({ error: 'Removed tenant not found' });
        }
        
        const tenant = verifyResult.rows[0];
        const tenantName = verifyResult.rows[0].full_name;
        
        await pool.query('DELETE FROM tenant_apartments WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM users WHERE id = $1 AND role = $2', [tenantId, 'tenant']);
        
        await logAudit(landlordId, 'PERMANENT_DELETE_TENANT', 'user', tenantId, `Permanently deleted tenant ${tenantName}`, ip);
        
        res.json({ 
            message: `Tenant "${tenantName}" has been permanently deleted.`,
            tenant_deleted: true
        });
    } catch (err) {
        console.error('Permanent delete tenant error:', err);
        res.status(500).json({ error: 'Failed to permanently delete tenant: ' + err.message });
    }
});

// ==================== LANDLORD MANAGEMENT ====================

app.get('/api/admin/landlords', authenticateToken, authorize('admin'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.full_name, u.email, u.phone, u.is_active,
                   COUNT(a.id) as apartment_count
            FROM users u
            LEFT JOIN apartments a ON u.id = a.landlord_id
            WHERE u.role = 'landlord'
            GROUP BY u.id
            ORDER BY u.full_name
        `);
        
        const landlordsWithStatus = result.rows.map(l => ({
            ...l,
            status: l.is_active && l.apartment_count > 0 ? 'active' : 'inactive'
        }));
        
        res.json(landlordsWithStatus);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch landlords: ' + err.message });
    }
});

app.delete('/api/admin/landlords/:id', authenticateToken, authorize('admin'), async (req, res) => {
    const landlordId = req.params.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        const landlordCheck = await pool.query(
            'SELECT id, full_name FROM users WHERE id = $1 AND role = $2',
            [landlordId, 'landlord']
        );
        
        if (landlordCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Landlord not found' });
        }
        
        const landlordName = landlordCheck.rows[0].full_name;
        
        await pool.query('UPDATE apartments SET landlord_id = NULL WHERE landlord_id = $1', [landlordId]);
        await pool.query('UPDATE users SET is_active = false WHERE id = $1 AND role = $2', [landlordId, 'landlord']);
        
        await logAudit(req.user.id, 'REMOVE_LANDLORD', 'user', landlordId, `Removed landlord ${landlordName}`, ip);
        
        res.json({ message: `Landlord "${landlordName}" removed successfully` });
    } catch (err) {
        console.error('Remove landlord error:', err);
        res.status(500).json({ error: 'Failed to remove landlord: ' + err.message });
    }
});

// ==================== TECHNICIAN MANAGEMENT ====================

app.post('/api/register/technician', authenticateToken, authorize('landlord'), async (req, res) => {
    const { full_name, email, phone, password, skills } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const userResult = await pool.query(
            'INSERT INTO users (email, password_hash, full_name, phone, role, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [email, hashedPassword, full_name, phone || '', 'technician', true]
        );
        
        const techId = userResult.rows[0].id;
        
        if (skills && skills.length > 0) {
            for (const skill of skills) {
                await pool.query(
                    'INSERT INTO technician_skills (technician_id, skill_name) VALUES ($1, $2)',
                    [techId, skill]
                );
            }
        }
        
        await logAudit(req.user.id, 'CREATE_TECHNICIAN', 'user', techId, `Created technician ${email}`, ip);
        
        res.json({ message: 'Technician created successfully', technician_id: techId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Creation failed: ' + err.message });
    }
});

app.get('/api/technicians/my', authenticateToken, authorize('landlord'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.full_name, u.email, u.phone, u.is_active,
                   COUNT(CASE WHEN ta.completed_at IS NULL THEN 1 END) as active_assignments,
                   COALESCE(array_agg(DISTINCT ts.skill_name) FILTER (WHERE ts.skill_name IS NOT NULL), ARRAY[]::text[]) as skills
            FROM users u
            LEFT JOIN technician_assignments ta ON u.id = ta.technician_id
            LEFT JOIN technician_skills ts ON u.id = ts.technician_id
            WHERE u.role = 'technician' AND u.is_active = true
            GROUP BY u.id
            ORDER BY u.created_at DESC
        `);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch technicians' });
    }
});

app.get('/api/technicians/all', authenticateToken, authorize('landlord'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.full_name, u.email, u.phone,
                   COUNT(CASE WHEN ta.completed_at IS NULL THEN 1 END) as active_assignments,
                   COALESCE(array_agg(DISTINCT ts.skill_name) FILTER (WHERE ts.skill_name IS NOT NULL), ARRAY[]::text[]) as skills
            FROM users u
            LEFT JOIN technician_assignments ta ON u.id = ta.technician_id
            LEFT JOIN technician_skills ts ON u.id = ts.technician_id
            WHERE u.role = 'technician' AND u.is_active = true
            GROUP BY u.id
            ORDER BY active_assignments ASC
        `);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch technicians' });
    }
});

app.delete('/api/technicians/:id', authenticateToken, authorize('landlord'), async (req, res) => {
    const technicianId = req.params.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        const assignmentCheck = await pool.query(
            'SELECT COUNT(*) FROM technician_assignments WHERE technician_id = $1 AND completed_at IS NULL',
            [technicianId]
        );
        
        if (parseInt(assignmentCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot remove technician with active issue assignments' });
        }
        
        const maintenanceCheck = await pool.query(
            'SELECT COUNT(*) FROM maintenance_schedules WHERE assigned_technician_id = $1 AND status NOT IN (\'completed\', \'cancelled\')',
            [technicianId]
        );
        
        if (parseInt(maintenanceCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot remove technician with active maintenance tasks' });
        }
        
        await pool.query('UPDATE users SET is_active = false WHERE id = $1 AND role = $2', [technicianId, 'technician']);
        
        await logAudit(req.user.id, 'REMOVE_TECHNICIAN', 'user', technicianId, `Removed technician ${technicianId}`, ip);
        
        res.json({ message: 'Technician removed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to remove technician: ' + err.message });
    }
});

// ==================== VERIFY TOKEN ====================

app.get('/api/verify', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
            [req.user.id]
        );
        
        if (result.rows.length === 0 || !result.rows[0].is_active) {
            return res.status(401).json({ error: 'User account disabled or deleted' });
        }
        
        res.json({ valid: true, user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ==================== PASSWORD RESET ROUTES ====================

app.post('/api/forgot-password', async (req, res) => {
    const { email, role } = req.body;
    
    if (!email || !role) {
        return res.status(400).json({ error: 'Email and role are required' });
    }
    
    try {
        console.log(`🔑 Password reset requested for: ${email} (${role})`);
        
        const userResult = await pool.query(
            'SELECT id, email, full_name, phone FROM users WHERE email = $1 AND role = $2 AND is_active = true',
            [email, role]
        );
        
        if (userResult.rows.length === 0) {
            console.log(`⚠️ User not found: ${email} (${role})`);
            return res.status(200).json({ message: 'If an account exists, a reset code will be sent to your email address.' });
        }
        
        const user = userResult.rows[0];
        const resetCode = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        
        console.log(`📧 Generated reset code for ${user.full_name}: ${resetCode}`);
        
        await pool.query(
            `INSERT INTO password_resets (user_id, reset_code, expires_at) 
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE 
             SET reset_code = $2, expires_at = $3, created_at = CURRENT_TIMESTAMP`,
            [user.id, resetCode, expiresAt]
        );
        
        const mailOptions = {
            from: EMAIL_FROM,
            to: user.email,
            subject: '🔐 PropCare - Password Reset Request',
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #0d3d2b 0%, #1e7a54 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0;">🔐 PropCare</h1>
                        <p style="color: #a8dfc5; margin: 5px 0 0;">Property Management System</p>
                    </div>
                    <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #c8e8d9; border-top: none;">
                        <p style="color: #0d1f18; font-size: 16px; margin-bottom: 20px;">Hello <strong style="color: #1e7a54;">${escapeHtmlForEmail(user.full_name)}</strong>,</p>
                        <p style="color: #0d1f18;">We received a request to reset your password for your PropCare account.</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; background: #edfaf3; padding: 20px; border-radius: 10px; color: #0d3d2b; font-family: monospace;">
                                ${resetCode}
                            </div>
                            <p style="color: #5a7a6b; font-size: 12px; margin-top: 10px;">⏰ This code expires in 30 minutes</p>
                        </div>
                        <p style="color: #0d1f18;">Enter this 6-digit code on the password reset page to create a new password.</p>
                        <hr style="border: none; border-top: 1px solid #c8e8d9; margin: 20px 0;">
                        <p style="color: #5a7a6b; font-size: 12px; margin: 0;">If you didn't request this, please ignore this email. Your password will remain unchanged.</p>
                    </div>
                    <div style="text-align: center; margin-top: 20px;">
                        <p style="color: #5a7a6b; font-size: 11px;">&copy; ${new Date().getFullYear()} PropCare System. All rights reserved.</p>
                    </div>
                </div>
            `,
            text: `PropCare Password Reset\n\nHello ${user.full_name},\n\nWe received a request to reset your password.\n\nYour reset code is: ${resetCode}\n\nThis code will expire in 30 minutes.\n\nIf you didn't request this, please ignore this email.`
        };
        
        const result = await sendEmail(mailOptions);
        
        if (result.success) {
            console.log(`✅ Password reset email sent to: ${user.email}`);
            res.json({ message: 'A password reset code has been sent to your email address.' });
        } else {
            console.error('❌ Failed to send email:', result.error.message);
            res.status(200).json({ 
                message: 'If an account exists, a reset code will be sent to your email address.'
            });
        }
    } catch (err) {
        console.error('Password reset error:', err);
        res.status(500).json({ error: 'Failed to send reset code. Please try again later.' });
    }
});

app.post('/api/verify-reset-code', async (req, res) => {
    const { email, role, resetCode } = req.body;
    
    if (!email || !role || !resetCode) {
        return res.status(400).json({ error: 'Email, role, and reset code are required' });
    }
    
    try {
        const userResult = await pool.query(
            'SELECT id FROM users WHERE email = $1 AND role = $2 AND is_active = true',
            [email, role]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        
        const userId = userResult.rows[0].id;
        
        const resetResult = await pool.query(
            `SELECT * FROM password_resets 
             WHERE user_id = $1 AND reset_code = $2 AND expires_at > CURRENT_TIMESTAMP 
             ORDER BY created_at DESC LIMIT 1`,
            [userId, resetCode]
        );
        
        if (resetResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset code' });
        }
        
        res.json({ message: 'Code verified successfully' });
    } catch (err) {
        console.error('Code verification error:', err);
        res.status(500).json({ error: 'Failed to verify code' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { email, role, resetCode, newPassword } = req.body;
    
    if (!email || !role || !resetCode || !newPassword) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    try {
        const userResult = await pool.query(
            'SELECT id FROM users WHERE email = $1 AND role = $2 AND is_active = true',
            [email, role]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        
        const userId = userResult.rows[0].id;
        
        const resetResult = await pool.query(
            `SELECT * FROM password_resets 
             WHERE user_id = $1 AND reset_code = $2 AND expires_at > CURRENT_TIMESTAMP 
             ORDER BY created_at DESC LIMIT 1`,
            [userId, resetCode]
        );
        
        if (resetResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset code' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashedPassword, userId]);
        
        await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
        
        await logAudit(userId, 'PASSWORD_RESET', 'user', userId, 'Password reset', req.ip);
        
        res.json({ message: 'Password reset successfully. Please login with your new password.' });
    } catch (err) {
        console.error('Password reset error:', err);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ==================== MAINTENANCE SCHEDULE ROUTES ====================

app.post('/api/maintenance/schedule', authenticateToken, authorize('landlord'), async (req, res) => {
    const { title, description, scheduled_date, estimated_duration, priority, affected_estates, notes, assigned_technician_ids } = req.body;
    const landlordId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (!title || !scheduled_date) {
        return res.status(400).json({ error: 'Title and scheduled date are required' });
    }
    
    try {
        let technicianIds = [];
        if (assigned_technician_ids) {
            if (Array.isArray(assigned_technician_ids)) {
                technicianIds = [...new Set(assigned_technician_ids)];
            } else if (typeof assigned_technician_ids === 'string') {
                technicianIds = [...new Set(assigned_technician_ids.split(',').map(id => parseInt(id.trim())))];
            }
        }
        
        technicianIds = [...new Set(technicianIds)];
        
        const createdSchedules = [];
        
        if (technicianIds.length > 0) {
            for (const techId of technicianIds) {
                const techCheck = await pool.query(
                    'SELECT id FROM users WHERE id = $1 AND role = $2 AND is_active = true',
                    [techId, 'technician']
                );
                
                if (techCheck.rows.length > 0) {
                    const result = await pool.query(
                        `INSERT INTO maintenance_schedules 
                         (landlord_id, title, description, scheduled_date, estimated_duration, priority, affected_estates, notes, status, assigned_technician_id) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                        [landlordId, title, description, scheduled_date, estimated_duration || null, 
                         priority || 'normal', affected_estates || null, notes || null, 'scheduled', techId]
                    );
                    createdSchedules.push(result.rows[0]);
                    
                    await sendNotification(
                        techId,
                        `🔧 New Maintenance: ${title}`,
                        `You have been assigned to maintenance on ${new Date(scheduled_date).toLocaleString()}: ${description || 'Please check details.'}`,
                        'maintenance_assignment',
                        result.rows[0].id
                    );
                }
            }
        } else {
            const result = await pool.query(
                `INSERT INTO maintenance_schedules 
                 (landlord_id, title, description, scheduled_date, estimated_duration, priority, affected_estates, notes, status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [landlordId, title, description, scheduled_date, estimated_duration || null, 
                 priority || 'normal', affected_estates || null, notes || null, 'scheduled']
            );
            createdSchedules.push(result.rows[0]);
        }
        
        if (affected_estates) {
            const estates = [...new Set(affected_estates.split(',').map(e => e.trim()))];
            const allTenantIds = new Set();
            
            for (const estate of estates) {
                const tenantsResult = await pool.query(`
                    SELECT DISTINCT u.id FROM users u
                    JOIN tenant_apartments ta ON u.id = ta.tenant_id
                    JOIN apartments a ON ta.apartment_id = a.id
                    WHERE a.estate_name = $1 AND a.landlord_id = $2 AND u.is_active = true
                `, [estate, landlordId]);
                
                for (const tenant of tenantsResult.rows) {
                    allTenantIds.add(tenant.id);
                }
            }
            
            for (const tenantId of allTenantIds) {
                await sendNotification(
                    tenantId,
                    `🔧 Maintenance: ${title}`,
                    `Scheduled maintenance on ${new Date(scheduled_date).toLocaleString()}: ${description || 'Please plan accordingly.'}`,
                    'maintenance',
                    createdSchedules[0]?.id
                );
            }
        }
        
        await logAudit(landlordId, 'CREATE_MAINTENANCE', 'maintenance', createdSchedules[0]?.id, `Created maintenance: ${title} for ${technicianIds.length} technician(s)`, ip);
        
        res.json({ message: `Maintenance scheduled successfully for ${technicianIds.length || 0} technician(s)`, schedules: createdSchedules });
    } catch (err) {
        console.error('Error creating maintenance:', err);
        res.status(500).json({ error: 'Failed to schedule maintenance: ' + err.message });
    }
});

app.get('/api/maintenance/schedules', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const role = req.user.role;
    
    try {
        let query;
        let params;
        
        if (role === 'landlord') {
            query = `
                SELECT DISTINCT ON (m.id) m.*, 
                       t.full_name as technician_name,
                       CASE 
                           WHEN m.scheduled_date > CURRENT_TIMESTAMP THEN 'upcoming'
                           WHEN m.scheduled_date <= CURRENT_TIMESTAMP AND m.status != 'completed' THEN 'ongoing'
                           ELSE m.status
                       END as display_status
                FROM maintenance_schedules m
                LEFT JOIN users t ON m.assigned_technician_id = t.id
                WHERE m.landlord_id = $1
                ORDER BY m.id, m.scheduled_date ASC
            `;
            params = [userId];
        } else if (role === 'tenant') {
            const tenantResult = await pool.query(`
                SELECT a.estate_name, a.unit_number 
                FROM apartments a
                JOIN tenant_apartments ta ON a.id = ta.apartment_id
                WHERE ta.tenant_id = $1 AND ta.is_current = true
            `, [userId]);
            
            if (tenantResult.rows.length === 0) {
                return res.json([]);
            }
            
            const estateName = tenantResult.rows[0].estate_name;
            
            query = `
                SELECT DISTINCT ON (m.id) m.*, 
                       u.full_name as landlord_name,
                       t.full_name as technician_name
                FROM maintenance_schedules m
                JOIN users u ON m.landlord_id = u.id
                LEFT JOIN users t ON m.assigned_technician_id = t.id
                WHERE (m.affected_estates IS NULL 
                       OR m.affected_estates = '' 
                       OR m.affected_estates ILIKE $1)
                AND m.status NOT IN ('cancelled', 'completed')
                AND m.scheduled_date > CURRENT_TIMESTAMP
                ORDER BY m.id, m.scheduled_date ASC
            `;
            params = [`%${estateName}%`];
        } else if (role === 'technician') {
            query = `
                SELECT DISTINCT ON (m.id) m.*, u.full_name as landlord_name
                FROM maintenance_schedules m
                JOIN users u ON m.landlord_id = u.id
                WHERE m.assigned_technician_id = $1
                ORDER BY m.id, m.scheduled_date ASC
            `;
            params = [userId];
        } else {
            query = `
                SELECT DISTINCT ON (m.id) m.*, u.full_name as landlord_name,
                       t.full_name as technician_name
                FROM maintenance_schedules m
                JOIN users u ON m.landlord_id = u.id
                LEFT JOIN users t ON m.assigned_technician_id = t.id
                ORDER BY m.id, m.scheduled_date ASC
            `;
            params = [];
        }
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching maintenance schedules:', err);
        res.status(500).json({ error: 'Failed to fetch maintenance schedules' });
    }
});

app.put('/api/maintenance/schedules/:id/status', authenticateToken, async (req, res) => {
    const scheduleId = parseInt(req.params.id);
    const { status } = req.body;
    const userId = req.user.id;
    const role = req.user.role;
    const ip = req.ip || req.connection.remoteAddress;
    
    const validStatuses = ['scheduled', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    
    try {
        let result;
        let schedule;
        
        if (role === 'technician') {
            result = await pool.query(
                `UPDATE maintenance_schedules 
                 SET status = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2 AND assigned_technician_id = $3
                 RETURNING *`,
                [status, scheduleId, userId]
            );
        } else if (role === 'landlord') {
            result = await pool.query(
                `UPDATE maintenance_schedules 
                 SET status = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2 AND landlord_id = $3
                 RETURNING *`,
                [status, scheduleId, userId]
            );
        } else {
            return res.status(403).json({ error: 'No permission to update maintenance status' });
        }
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Schedule not found or no permission' });
        }
        
        schedule = result.rows[0];
        
        if (role === 'technician' && schedule.landlord_id) {
            await sendNotification(
                schedule.landlord_id,
                `Maintenance Status Update: ${schedule.title}`,
                `Technician has updated maintenance status to ${status}.`,
                'maintenance_update',
                scheduleId
            );
        }
        
        if (role === 'landlord' && schedule.assigned_technician_id) {
            await sendNotification(
                schedule.assigned_technician_id,
                `Maintenance Status: ${status}`,
                `Maintenance "${schedule.title}" status changed to ${status} by landlord.`,
                'maintenance_update',
                scheduleId
            );
        }
        
        await logAudit(userId, 'UPDATE_MAINTENANCE_STATUS', 'maintenance', scheduleId, `Updated status to ${status}`, ip);
        
        res.json({ message: 'Maintenance status updated', schedule: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update maintenance status: ' + err.message });
    }
});

app.delete('/api/maintenance/schedules/:id', authenticateToken, authorize('landlord'), async (req, res) => {
    const scheduleId = parseInt(req.params.id);
    const landlordId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        const result = await pool.query(
            'DELETE FROM maintenance_schedules WHERE id = $1 AND landlord_id = $2 RETURNING id',
            [scheduleId, landlordId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        
        await logAudit(landlordId, 'DELETE_MAINTENANCE', 'maintenance', scheduleId, 'Deleted maintenance schedule', ip);
        
        res.json({ message: 'Maintenance schedule deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete schedule' });
    }
});

// ==================== ISSUE MANAGEMENT ====================

app.get('/api/issues', authenticateToken, async (req, res) => {
    const { status, risk_level } = req.query;
    const userId = req.user.id;
    const role = req.user.role;
    
    try {
        let query = '';
        let params = [];
        let paramCount = 1;
        
        if (role === 'tenant') {
            query = `
                SELECT i.*, a.estate_name, a.unit_number, 
                       t.full_name as technician_name, t.phone as technician_phone, t.email as technician_email
                FROM issues i 
                JOIN apartments a ON i.apartment_id = a.id 
                LEFT JOIN users t ON i.assigned_technician_id = t.id
                WHERE i.tenant_id = $1
            `;
            params.push(userId);
            paramCount++;
        } else if (role === 'landlord') {
            query = `
                SELECT i.*, a.estate_name, a.unit_number, 
                       u.full_name as tenant_name, u.email as tenant_email, u.phone as tenant_phone,
                       t.full_name as technician_name
                FROM issues i
                JOIN apartments a ON i.apartment_id = a.id
                JOIN users u ON i.tenant_id = u.id
                LEFT JOIN users t ON i.assigned_technician_id = t.id
                WHERE a.landlord_id = $1
            `;
            params.push(userId);
            paramCount++;
        } else if (role === 'technician') {
            query = `
                SELECT i.*, a.estate_name, a.unit_number, u.full_name as tenant_name, u.phone as tenant_phone
                FROM issues i
                JOIN apartments a ON i.apartment_id = a.id
                JOIN users u ON i.tenant_id = u.id
                WHERE i.assigned_technician_id = $1
            `;
            params.push(userId);
            paramCount++;
        } else {
            query = `
                SELECT i.*, a.estate_name, a.unit_number, u.full_name as tenant_name, 
                       t.full_name as technician_name, l.full_name as landlord_name
                FROM issues i
                JOIN apartments a ON i.apartment_id = a.id
                JOIN users u ON i.tenant_id = u.id
                LEFT JOIN users t ON i.assigned_technician_id = t.id
                LEFT JOIN users l ON a.landlord_id = l.id
                WHERE 1=1
            `;
        }
        
        if (status) {
            query += ` AND i.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }
        
        if (risk_level) {
            query += ` AND i.risk_level = $${paramCount}`;
            params.push(risk_level);
            paramCount++;
        }
        
        query += ` ORDER BY 
            CASE 
                WHEN i.risk_level = 'Emergency' AND i.status != 'Resolved' THEN 1 
                WHEN i.risk_level = 'Urgent' AND i.status != 'Resolved' THEN 2 
                WHEN i.status != 'Resolved' THEN 3 
                ELSE 4 
            END, 
            i.reported_at DESC`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch issues' });
    }
});

app.post('/api/issues', authenticateToken, authorize('tenant'), upload.single('photo'), async (req, res) => {
    const { title, description, risk_level } = req.body;
    const tenantId = req.user.id;
    let photoUrl = null;
    
    if (req.file) {
        photoUrl = `/uploads/${req.file.filename}`;
    }
    
    try {
        const apartmentResult = await pool.query(
            `SELECT a.* FROM apartments a 
             JOIN tenant_apartments ta ON a.id = ta.apartment_id 
             WHERE ta.tenant_id = $1 AND ta.is_current = true`,
            [tenantId]
        );
        
        if (apartmentResult.rows.length === 0) {
            return res.status(400).json({ error: 'No apartment assigned' });
        }
        
        const apartment = apartmentResult.rows[0];
        
        const result = await pool.query(
            `INSERT INTO issues (tenant_id, apartment_id, title, description, risk_level, photo_url, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [tenantId, apartment.id, title, description, risk_level, photoUrl, 'Open']
        );
        
        const issue = result.rows[0];
        
        if (apartment.landlord_id) {
            await sendNotification(
                apartment.landlord_id,
                risk_level === 'Emergency' ? '🚨 EMERGENCY ISSUE' : 'New Issue Reported',
                `${risk_level === 'Emergency' ? 'EMERGENCY: ' : ''}${title} at ${apartment.estate_name} Unit ${apartment.unit_number}`,
                'issue_reported',
                issue.id
            );
        }
        
        await sendNotification(
            tenantId,
            'Issue Submitted',
            `Your issue "${title}" has been submitted successfully.`,
            'issue_update',
            issue.id
        );
        
        await logAudit(tenantId, 'CREATE_ISSUE', 'issue', issue.id, `Created ${risk_level} issue: ${title}`, req.ip);
        
        res.json({ message: 'Issue reported successfully', issue });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit issue' });
    }
});

app.put('/api/issues/:id/status', authenticateToken, async (req, res) => {
    const { status } = req.body;
    const issueId = parseInt(req.params.id);
    const userId = req.user.id;
    const role = req.user.role;
    
    const validStatuses = ['Open', 'In Progress', 'Resolved'];
    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    
    if (isNaN(issueId)) {
        return res.status(400).json({ error: 'Invalid issue ID' });
    }
    
    try {
        let hasPermission = false;
        let issueData = null;
        
        if (role === 'admin') {
            const result = await pool.query('SELECT * FROM issues WHERE id = $1', [issueId]);
            if (result.rows.length > 0) {
                hasPermission = true;
                issueData = result.rows[0];
            }
        } 
        else if (role === 'landlord') {
            const result = await pool.query(
                `SELECT i.* FROM issues i
                 JOIN apartments a ON i.apartment_id = a.id
                 WHERE i.id = $1 AND a.landlord_id = $2`,
                [issueId, userId]
            );
            if (result.rows.length > 0) {
                hasPermission = true;
                issueData = result.rows[0];
            }
        } 
        else if (role === 'technician') {
            const result = await pool.query(
                'SELECT * FROM issues WHERE id = $1 AND assigned_technician_id = $2',
                [issueId, userId]
            );
            if (result.rows.length > 0) {
                hasPermission = true;
                issueData = result.rows[0];
            }
        }
        
        if (!hasPermission || !issueData) {
            return res.status(403).json({ error: 'No permission to update this issue' });
        }
        
        const oldStatus = issueData.status;
        
        let result;
        if (status === 'Resolved') {
            result = await pool.query(
                `UPDATE issues SET status = $1, updated_at = CURRENT_TIMESTAMP, resolved_at = CURRENT_TIMESTAMP
                 WHERE id = $2 RETURNING *`,
                [status, issueId]
            );
        } else {
            result = await pool.query(
                `UPDATE issues SET status = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2 RETURNING *`,
                [status, issueId]
            );
        }
        
        const updatedIssue = result.rows[0];
        
        if (!updatedIssue) {
            return res.status(404).json({ error: 'Issue not found' });
        }
        
        await sendNotification(
            updatedIssue.tenant_id,
            `Issue Status Updated to ${status}`,
            `Your issue "${updatedIssue.title}" is now ${status}.`,
            'issue_update',
            issueId
        );
        
        if (status === 'Resolved') {
            await sendNotification(
                updatedIssue.tenant_id,
                '✅ Issue Resolved',
                `Your issue "${updatedIssue.title}" has been marked as resolved. Thank you!`,
                'issue_update',
                issueId
            );
        }
        
        await logAudit(userId, 'UPDATE_ISSUE_STATUS', 'issue', issueId, `Changed status from ${oldStatus} to ${status}`, req.ip);
        
        res.json({ message: 'Issue status updated successfully', issue: updatedIssue });
    } catch (err) {
        console.error('Error updating issue status:', err);
        res.status(500).json({ error: 'Failed to update issue status: ' + err.message });
    }
});

app.post('/api/issues/:id/assign', authenticateToken, authorize('landlord'), async (req, res) => {
    const { technician_id } = req.body;
    const issueId = parseInt(req.params.id);
    const userId = req.user.id;
    
    if (isNaN(issueId)) {
        return res.status(400).json({ error: 'Invalid issue ID' });
    }
    
    try {
        const techCheck = await pool.query(
            'SELECT id, full_name, email, phone FROM users WHERE id = $1 AND role = $2 AND is_active = true',
            [technician_id, 'technician']
        );
        
        if (techCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or inactive technician' });
        }
        
        const issueResult = await pool.query(
            `SELECT i.*, a.estate_name, a.unit_number FROM issues i
             JOIN apartments a ON i.apartment_id = a.id
             WHERE i.id = $1 AND a.landlord_id = $2`,
            [issueId, userId]
        );
        
        if (issueResult.rows.length === 0) {
            return res.status(404).json({ error: 'Issue not found or not under your properties' });
        }
        
        const issue = issueResult.rows[0];
        
        await pool.query(
            'UPDATE issues SET assigned_technician_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [technician_id, issueId]
        );
        
        await pool.query(
            'INSERT INTO technician_assignments (technician_id, issue_id, status) VALUES ($1, $2, $3)',
            [technician_id, issueId, 'Assigned']
        );
        
        await sendNotification(
            technician_id,
            'New Issue Assigned',
            `You have been assigned to issue: ${issue.title} at ${issue.estate_name} Unit ${issue.unit_number}`,
            'assignment',
            issueId
        );
        
        await sendNotification(
            issue.tenant_id,
            'Technician Assigned',
            `A technician has been assigned to your issue "${issue.title}".`,
            'assignment',
            issueId
        );
        
        await logAudit(userId, 'ASSIGN_TECHNICIAN', 'issue', issueId, `Assigned technician ${technician_id}`, req.ip);
        
        res.json({ message: 'Technician assigned successfully', technician: techCheck.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to assign technician' });
    }
});

app.put('/api/issues/:id/technician', authenticateToken, authorize('landlord'), async (req, res) => {
    const { technician_id } = req.body;
    const issueId = parseInt(req.params.id);
    const userId = req.user.id;
    
    if (!technician_id) {
        return res.status(400).json({ error: 'Technician ID is required' });
    }
    
    if (isNaN(issueId)) {
        return res.status(400).json({ error: 'Invalid issue ID' });
    }
    
    try {
        const issueResult = await pool.query(
            `SELECT i.* FROM issues i
             JOIN apartments a ON i.apartment_id = a.id
             WHERE i.id = $1 AND a.landlord_id = $2`,
            [issueId, userId]
        );
        
        if (issueResult.rows.length === 0) {
            return res.status(403).json({ error: 'Issue not found under your properties' });
        }
        
        const issueData = issueResult.rows[0];
        
        const techCheck = await pool.query(
            'SELECT id, full_name FROM users WHERE id = $1 AND role = $2 AND is_active = true',
            [technician_id, 'technician']
        );
        
        if (techCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or inactive technician' });
        }
        
        const previousTechId = issueData.assigned_technician_id;
        
        await pool.query(
            'UPDATE issues SET assigned_technician_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [technician_id, issueId]
        );
        
        if (previousTechId) {
            await pool.query(
                'UPDATE technician_assignments SET completed_at = CURRENT_TIMESTAMP, status = $1 WHERE issue_id = $2 AND completed_at IS NULL',
                ['Replaced', issueId]
            );
        }
        
        await pool.query(
            'INSERT INTO technician_assignments (technician_id, issue_id, status) VALUES ($1, $2, $3)',
            [technician_id, issueId, 'Assigned']
        );
        
        await sendNotification(
            technician_id,
            'New Issue Assigned',
            `You have been assigned to issue: ${issueData.title}`,
            'assignment',
            issueId
        );
        
        if (previousTechId) {
            await sendNotification(
                previousTechId,
                'Assignment Changed',
                `You have been reassigned from issue: ${issueData.title}`,
                'assignment',
                issueId
            );
        }
        
        await sendNotification(
            issueData.tenant_id,
            'Technician Reassigned',
            `A new technician has been assigned to your issue "${issueData.title}".`,
            'assignment',
            issueId
        );
        
        await logAudit(userId, 'CHANGE_TECHNICIAN', 'issue', issueId, `Changed technician from ${previousTechId} to ${technician_id}`, req.ip);
        
        res.json({ message: 'Technician changed successfully', technician: techCheck.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to change technician' });
    }
});

app.delete('/api/issues/:id/technician', authenticateToken, authorize('landlord'), async (req, res) => {
    const issueId = parseInt(req.params.id);
    const userId = req.user.id;
    
    if (isNaN(issueId)) {
        return res.status(400).json({ error: 'Invalid issue ID' });
    }
    
    try {
        const issueResult = await pool.query(
            `SELECT i.* FROM issues i
             JOIN apartments a ON i.apartment_id = a.id
             WHERE i.id = $1 AND a.landlord_id = $2`,
            [issueId, userId]
        );
        
        if (issueResult.rows.length === 0) {
            return res.status(403).json({ error: 'Issue not found under your properties' });
        }
        
        const issueData = issueResult.rows[0];
        const previousTechId = issueData.assigned_technician_id;
        
        await pool.query(
            'UPDATE issues SET assigned_technician_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [issueId]
        );
        
        await pool.query(
            'UPDATE technician_assignments SET completed_at = CURRENT_TIMESTAMP, status = $1 WHERE issue_id = $2 AND completed_at IS NULL',
            ['Removed', issueId]
        );
        
        if (previousTechId) {
            await sendNotification(
                previousTechId,
                'Assignment Removed',
                `You have been unassigned from issue: ${issueData.title}`,
                'assignment',
                issueId
            );
        }
        
        await sendNotification(
            issueData.tenant_id,
            'Technician Unassigned',
            `The technician has been unassigned from your issue "${issueData.title}".`,
            'assignment',
            issueId
        );
        
        await logAudit(userId, 'UNASSIGN_TECHNICIAN', 'issue', issueId, `Unassigned technician ${previousTechId}`, req.ip);
        
        res.json({ message: 'Technician unassigned successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to unassign technician' });
    }
});

// ==================== NOTIFICATION ROUTES ====================

app.get('/api/notifications', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    
    try {
        const result = await pool.query(
            'SELECT DISTINCT ON (id) * FROM notifications WHERE user_id = $1 ORDER BY id, created_at DESC LIMIT 50',
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
    const notificationId = parseInt(req.params.id);
    const userId = req.user.id;
    
    try {
        await pool.query(
            'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
            [notificationId, userId]
        );
        res.json({ message: 'Notification marked as read' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
});

app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    
    try {
        await pool.query(
            'UPDATE notifications SET is_read = true WHERE user_id = $1',
            [userId]
        );
        res.json({ message: 'All notifications marked as read' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});

app.post('/api/notifications/broadcast', authenticateToken, authorize('landlord'), async (req, res) => {
    const { title, message, target_estate, specific_tenant_id } = req.body;
    const landlordId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    try {
        let tenantsResult;
        
        if (specific_tenant_id) {
            const tenantCheck = await pool.query(`
                SELECT u.id FROM users u
                JOIN tenant_apartments ta ON u.id = ta.tenant_id
                JOIN apartments a ON ta.apartment_id = a.id
                WHERE u.id = $1 AND a.landlord_id = $2 AND u.is_active = true
            `, [specific_tenant_id, landlordId]);
            
            if (tenantCheck.rows.length === 0) {
                return res.status(400).json({ error: 'Tenant not found under your properties' });
            }
            
            tenantsResult = { rows: [{ id: specific_tenant_id }] };
        } else {
            let query = `
                SELECT DISTINCT u.id, u.full_name FROM users u
                JOIN tenant_apartments ta ON u.id = ta.tenant_id
                JOIN apartments a ON ta.apartment_id = a.id
                WHERE a.landlord_id = $1 AND u.is_active = true
            `;
            let params = [landlordId];
            
            if (target_estate && target_estate !== 'all') {
                query += ' AND a.estate_name = $2';
                params.push(target_estate);
            }
            
            tenantsResult = await pool.query(query, params);
        }
        
        const uniqueTenantIds = [...new Set(tenantsResult.rows.map(t => t.id))];
        
        for (const tenantId of uniqueTenantIds) {
            await sendNotification(tenantId, title, message, 'broadcast');
        }
        
        await logAudit(landlordId, 'SEND_BROADCAST', 'broadcast', null, `Sent broadcast: ${title} to ${uniqueTenantIds.length} tenants`, ip);
        
        res.json({ message: 'Broadcast sent successfully', recipients_count: uniqueTenantIds.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send broadcast' });
    }
});

app.get('/api/notifications/broadcasts/sent', authenticateToken, authorize('landlord'), async (req, res) => {
    const landlordId = req.user.id;
    
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (n.id) n.* 
            FROM notifications n
            WHERE n.user_id IN (
                SELECT DISTINCT u.id FROM users u
                JOIN tenant_apartments ta ON u.id = ta.tenant_id
                JOIN apartments a ON ta.apartment_id = a.id
                WHERE a.landlord_id = $1
            )
            AND n.type = 'broadcast'
            ORDER BY n.id, n.created_at DESC
            LIMIT 100
        `, [landlordId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch broadcasts' });
    }
});

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/users', authenticateToken, authorize('admin'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, email, full_name, phone, role, is_active, created_at
            FROM users ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.get('/api/admin/stats', authenticateToken, authorize('admin'), async (req, res) => {
    try {
        const stats = {};
        
        const userCounts = await pool.query(`SELECT role, COUNT(*) as count FROM users WHERE is_active = true GROUP BY role`);
        stats.users_by_role = userCounts.rows;
        
        const apartmentCounts = await pool.query(`
            SELECT COUNT(*) as total, COUNT(CASE WHEN is_occupied = true THEN 1 END) as occupied FROM apartments
        `);
        stats.apartments = apartmentCounts.rows[0];
        
        const issueStats = await pool.query(`
            SELECT COUNT(*) as total_issues,
                   COUNT(CASE WHEN status = 'Open' THEN 1 END) as open,
                   COUNT(CASE WHEN status = 'Resolved' THEN 1 END) as resolved,
                   COUNT(CASE WHEN risk_level = 'Emergency' THEN 1 END) as emergency,
                   COUNT(CASE WHEN risk_level = 'Urgent' THEN 1 END) as urgent,
                   COUNT(CASE WHEN risk_level = 'Less Urgent' THEN 1 END) as less_urgent
            FROM issues
        `);
        stats.total_issues = issueStats.rows[0].total_issues;
        stats.issues_by_status = [
            { status: 'Open', count: issueStats.rows[0].open || 0 },
            { status: 'Resolved', count: issueStats.rows[0].resolved || 0 },
            { status: 'Emergency', count: issueStats.rows[0].emergency || 0 },
            { status: 'Urgent', count: issueStats.rows[0].urgent || 0 },
            { status: 'Less Urgent', count: issueStats.rows[0].less_urgent || 0 }
        ];
        
        const pendingRequests = await pool.query(
            "SELECT COUNT(*) FROM tenant_registration_requests WHERE status = 'pending' AND expires_at > CURRENT_TIMESTAMP"
        );
        stats.pending_registrations = parseInt(pendingRequests.rows[0].count);
        
        res.json(stats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

app.get('/api/admin/monthly-stats', authenticateToken, authorize('admin'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                TO_CHAR(DATE_TRUNC('month', reported_at), 'Mon YYYY') as month,
                COUNT(*) as count
            FROM issues
            WHERE reported_at > CURRENT_DATE - INTERVAL '6 months'
            GROUP BY DATE_TRUNC('month', reported_at)
            ORDER BY DATE_TRUNC('month', reported_at) DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch monthly stats' });
    }
});

// ==================== REPORTS ROUTE ====================

app.get('/api/landlord/reports', authenticateToken, authorize('landlord'), async (req, res) => {
    const landlordId = req.user.id;
    
    try {
        const apartmentStats = await pool.query(`
            SELECT 
                COUNT(*) as total_apartments,
                COUNT(CASE WHEN is_occupied = true THEN 1 END) as occupied_apartments,
                COUNT(CASE WHEN is_occupied = false THEN 1 END) as available_apartments,
                ROUND(COUNT(CASE WHEN is_occupied = true THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as occupancy_rate
            FROM apartments WHERE landlord_id = $1
        `, [landlordId]);
        
        const issueStats = await pool.query(`
            SELECT 
                COUNT(*) as total_issues,
                COUNT(CASE WHEN status = 'Open' THEN 1 END) as open_issues,
                COUNT(CASE WHEN status = 'In Progress' THEN 1 END) as in_progress_issues,
                COUNT(CASE WHEN status = 'Resolved' THEN 1 END) as resolved_issues,
                COUNT(CASE WHEN risk_level = 'Emergency' THEN 1 END) as emergency_issues,
                COUNT(CASE WHEN risk_level = 'Urgent' THEN 1 END) as urgent_issues,
                COUNT(CASE WHEN risk_level = 'Less Urgent' THEN 1 END) as less_urgent_issues
            FROM issues i
            JOIN apartments a ON i.apartment_id = a.id
            WHERE a.landlord_id = $1
        `, [landlordId]);
        
        const issuesByMonth = await pool.query(`
            SELECT 
                TO_CHAR(DATE_TRUNC('month', i.reported_at), 'Mon YYYY') as month,
                COUNT(*) as count
            FROM issues i
            JOIN apartments a ON i.apartment_id = a.id
            WHERE a.landlord_id = $1
            GROUP BY DATE_TRUNC('month', i.reported_at)
            ORDER BY DATE_TRUNC('month', i.reported_at) DESC
            LIMIT 6
        `, [landlordId]);
        
        const estatesPerformance = await pool.query(`
            SELECT 
                a.estate_name,
                COUNT(DISTINCT a.id) as units,
                COUNT(DISTINCT CASE WHEN a.is_occupied = true THEN a.id END) as occupied_units,
                COUNT(DISTINCT i.id) as issues_reported,
                COUNT(DISTINCT CASE WHEN i.status = 'Resolved' THEN i.id END) as issues_resolved
            FROM apartments a
            LEFT JOIN issues i ON a.id = i.apartment_id
            WHERE a.landlord_id = $1
            GROUP BY a.estate_name
            ORDER BY a.estate_name
        `, [landlordId]);
        
        const tenantStats = await pool.query(`
            SELECT 
                COUNT(DISTINCT u.id) as total_tenants,
                COUNT(DISTINCT CASE WHEN u.created_at > CURRENT_DATE - INTERVAL '30 days' THEN u.id END) as new_tenants_30d
            FROM users u
            JOIN tenant_apartments ta ON u.id = ta.tenant_id
            JOIN apartments a ON ta.apartment_id = a.id
            WHERE a.landlord_id = $1 AND u.role = 'tenant' AND u.is_active = true
        `, [landlordId]);
        
        const resolutionTime = await pool.query(`
            SELECT 
                AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.reported_at))/3600) as avg_resolution_hours
            FROM issues i
            JOIN apartments a ON i.apartment_id = a.id
            WHERE a.landlord_id = $1 AND i.status = 'Resolved' AND i.resolved_at IS NOT NULL
        `, [landlordId]);
        
        res.json({
            apartments: apartmentStats.rows[0],
            issues: issueStats.rows[0],
            issues_by_month: issuesByMonth.rows,
            estates_performance: estatesPerformance.rows,
            tenants: tenantStats.rows[0],
            avg_resolution_hours: Math.round(resolutionTime.rows[0]?.avg_resolution_hours || 0)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

// ==================== SERVE HTML FILES ====================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/admin-login.html', (req, res) => res.sendFile(path.join(__dirname, 'admin-login.html')));
app.get('/admin-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'admin-dashboard.html')));
app.get('/tenant-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'tenant-dashboard.html')));
app.get('/landlord-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'landlord-dashboard.html')));
app.get('/technician-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'technician-dashboard.html')));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 PropCare Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket enabled for real-time notifications`);
    console.log(`\n📝 Admin Login: admin@propcare.com / admin123`);
    console.log(`\n📧 Email Service: Brevo SMTP`);
    console.log(`📧 SMTP Host: ${process.env.EMAIL_HOST}`);
    console.log(`\n🔐 Password Reset: Click "Forgot Password?" on login page`);
    console.log(`\n✅ FIXED: Restore tenant now checks for ACTIVE tenants in the apartment`);
    console.log(`✅ FIXED: Remove tenant properly marks apartment as available`);
    console.log(`✅ FIXED: Apartment occupancy sync between is_occupied flag and actual tenants`);
    console.log(`\n📋 Features:`);
    console.log(`   • Active tenants shown in main list`);
    console.log(`   • Removed tenants shown in separate section with Restore & Delete`);
    console.log(`   • Available apartments filtered correctly for registration`);
    console.log(`   • Email notifications for tenant registration and approval`);
    console.log(`   • Each tenant-apartment relationship is independent`);
    console.log(`\n${'='.repeat(60)}\n`);
    console.log(`👉 Open your browser and go to: http://localhost:${PORT}`);
    console.log(`\n📧 To test email, use: POST /api/test-email with {"email": "your-email@example.com"}\n`);
});
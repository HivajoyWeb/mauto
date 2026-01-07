const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');


// ============ Configuration ============
const token = '7902407945:AAFCJidyZ1ELUnQuR41iv6QJkslc8j9SzRI';
const bot = new TelegramBot(token, { polling: true });
const token2 = '8425131768:AAGtC8oSlLkm-UfZNZMtGtxVzZgnd61z0pg';
const bot2 = new TelegramBot(token2, { polling: true });
const mongoUri = 'mongodb+srv://innoshivmail_db_user:XTapIQz6cuV5GK3Z@cluster0.gf7qarp.mongodb.net/?appName=Cluster0';
const channelId = '-1003398223490';

// ============ MongoDB Connection ============
const dbConnection = mongoose.createConnection(mongoUri);

dbConnection.on('connected', () => {
  console.log('✅ Connected to MongoDB');
});

dbConnection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

// ============ User Schema & Model ============
const userSchema = new mongoose.Schema({
  userId: { type: Number, unique: true, required: true },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  username: { type: String, default: '' },
  isBlocked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now },
  totalInteractions: { type: Number, default: 0 }
});

const User = dbConnection.model('User', userSchema);

// ============ YouTube Schema ============
const Youtube = dbConnection.model('Youtube', new mongoose.Schema({
  videoId: { type: String, required: true, unique: true, index: true },
  title: String,
  artist: String,
  messageId: Number,
  duration: Number,
  createdAt: { type: Date, default: Date.now }
}));

// ============ JioSaavan Schema ============
const Saavan = dbConnection.model('Saavan', new mongoose.Schema({
  songId: { type: String, required: true, unique: true, index: true },
  title: String,
  artist: String,
  messageId: Number,
  duration: Number,
  saavnUrl: String,
  createdAt: { type: Date, default: Date.now }
}));

// ============ Spotify Schema ============
const Spotify = dbConnection.model('Spotify', new mongoose.Schema({
  songId: { type: String, required: true, unique: true, index: true },
  title: String,
  artist: String,
  messageId: Number,
  duration: Number,
  createdAt: { type: Date, default: Date.now }
}));

module.exports = { bot, bot2, User, Youtube, Saavan, Spotify, channelId};

const { bot} = require('./telegram');

const automation = require('./saavnAuto');
//automation.downloadByArtist('456269');
const automation2 = require('./saavnAuto2');
//automation2.downloadByArtist('5250811');


// ============ Error Handling ============

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

bot.on('error', (error) => {
  console.error('Bot error:', error.message);
});

// ============ Graceful Shutdown ============

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await bot.stopPolling();
  await dbConnection.close();
  console.log('👋 Goodbye!');
  process.exit(0);
});

console.log('SaavnAutomation Bot is running...');

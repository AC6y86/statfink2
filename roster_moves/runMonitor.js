const GmailRosterMonitor = require('./emailMonitor');

const CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

class RosterMoveService {
  constructor() {
    this.monitor = null;
    this.intervalId = null;
  }

  async start() {
    console.log('Starting Roster Move Email Monitoring Service...');
    this.monitor = new GmailRosterMonitor();
    
    try {
      await this.monitor.initialize();
      
      // Check immediately on startup
      await this.checkEmails();
      
      // Then check periodically
      this.intervalId = setInterval(() => {
        this.checkEmails();
      }, CHECK_INTERVAL);
      
      console.log(`Service started. Checking emails every ${CHECK_INTERVAL / 1000} seconds`);
      console.log('Press Ctrl+C to stop\n');
      
    } catch (error) {
      console.error('Failed to start service:', error);
      process.exit(1);
    }
  }

  async checkEmails() {
    const timestamp = new Date().toLocaleString();
    console.log(`[${timestamp}] Checking for new roster move emails...`);
    
    try {
      await this.monitor.processEmails();
    } catch (error) {
      console.error(`[${timestamp}] Error checking emails:`, error);
    }
  }

  async stop() {
    console.log('\nStopping service...');
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    
    if (this.monitor) {
      await this.monitor.close();
    }
    
    console.log('Service stopped');
  }
}

// Main execution
const service = new RosterMoveService();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await service.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await service.stop();
  process.exit(0);
});

// Start the service
service.start().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
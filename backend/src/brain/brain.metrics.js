const { readBrain, writeBrain } = require('./brain.store');

function recordTrade({ profit }) {
  const brain = readBrain();

  brain.stats.totalTrades += 1;

  if (profit > 0) {
    brain.stats.wins += 1;
    brain.stats.totalWinUSD += profit;
  } else {
    brain.stats.losses += 1;
    brain.stats.totalLossUSD += Math.abs(profit);
  }

  brain.stats.netPnL =
    brain.stats.totalWinUSD - brain.stats.totalLossUSD;

  brain.history.push({
    time: Date.now(),
    profit
  });

  writeBrain(brain);
  return brain.stats;
}

function getStats() {
  return readBrain().stats;
}

module.exports = {
  recordTrade,
  getStats,
};

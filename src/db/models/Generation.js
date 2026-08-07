import mongoose from 'mongoose';

const generationSchema = new mongoose.Schema(
  {
    appName: String,
    description: String,
    contract: mongoose.Schema.Types.Mixed,
    files: mongoose.Schema.Types.Mixed,
    status: { type: String, enum: ['planned', 'built'], default: 'planned' },
    validation: mongoose.Schema.Types.Mixed,
    attempts: Number,
    plannerUsage: mongoose.Schema.Types.Mixed,
    buildUsageLog: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

export default mongoose.model('Generation', generationSchema);

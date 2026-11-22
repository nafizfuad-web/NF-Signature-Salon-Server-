
import mongoose from "mongoose";
const connectDB = async (mongoURI: string): Promise<void> => {
  await mongoose.connect(mongoURI);
};

export default connectDB;

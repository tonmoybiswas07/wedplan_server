import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is required in .env");
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 5000,
});

export const db = client.db(process.env.MONGODB_DB || "WedPlanDB");
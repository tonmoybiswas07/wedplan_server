import { ObjectId } from "mongodb";
import { db } from "./db.js";

export const serviceStatuses = ["pending", "approved", "rejected"] as const;
export type Service = {
  vendorId: string;
  title: string;
  category: string;
  location?: string;
  description: string;
  priceMinor: number;
  imageUrl?: string;
  imageUrls?: string[];
  status: (typeof serviceStatuses)[number];
  isActive?: boolean;
  active?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const services = db.collection<Service>("services");

export function serviceId(id: string | string[] | undefined) {
  return typeof id === "string" && /^[\da-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}

export function serializeService({ _id, vendorId: _vendorId, active, isActive, ...service }: Service & { _id: ObjectId }) {
  const available = isActive ?? active ?? false;
  return { id: _id.toHexString(), ...service, isActive: available, active: available };
}

export function moderationUpdate(status: Service["status"]) {
  return { $set: { status, isActive: false, updatedAt: new Date() }, $unset: { active: "" as const } };
}

import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv(r'c:\Users\CraftingTable\Desktop\hacksus_brandnew\.env')
uri = os.getenv('MONGODB_URI')
print(f"Connecting to: {uri[:40]}...")
try:
    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    client.admin.command('ping')
    print("MongoDB connection SUCCESS!")
except Exception as e:
    print(f"MongoDB connection ERROR: {e}")

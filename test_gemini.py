import google.generativeai as genai
import os
from dotenv import load_dotenv

load_dotenv(r'c:\Users\CraftingTable\Desktop\hacksus_brandnew\.env')
api_key = os.getenv('GEMINI_API_KEY')
try:
    genai.configure(api_key=api_key)
    for m in genai.list_models():
        if 'generateContent' in m.supported_generation_methods:
            print(m.name)
except Exception as e:
    print('Gemini API Error:', str(e))

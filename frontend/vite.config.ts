import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import 'dotenv/config';
export default defineConfig({root:'frontend',plugins:[react()],server:{host:'127.0.0.1',port:Number(process.env.FRONTEND_PORT||5173),strictPort:true,proxy:{'/api':`http://127.0.0.1:${process.env.BACKEND_PORT||3001}`}},build:{outDir:'dist'}});

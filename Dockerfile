FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

COPY . .
RUN npx prisma generate
RUN npm run build

EXPOSE 3000

ENV HOSTNAME=0.0.0.0

CMD ["npm", "run", "start"]

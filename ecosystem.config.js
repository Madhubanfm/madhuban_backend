module.exports = {
  apps: [
    {
      name: "madhuban",
      script: "npm",
      args: "run start",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};

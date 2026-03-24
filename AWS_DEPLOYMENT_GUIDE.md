# AWS Deployment Guide: Tech-Trolley

Since your application is now hosted on AWS Elastic Beanstalk and connected to GitHub, you should follow a "Push to Deploy" workflow. You generally do **not** need to manually `git pull` on the AWS server itself.

## 1. Automated Deployment (Recommended)
If you have connected your GitHub repository to AWS using **AWS CodePipeline**:

1. **Make changes** locally on your computer.
2. **Commit and Push** to GitHub:
   ```bash
   git add .
   git commit -m "Description of changes"
   git push origin main
   ```
3. **AWS handles the rest**: AWS CodePipeline will detect the push, build the application, and deploy it to your Elastic Beanstalk environment (`tech-trolley-env`).

> [!TIP]
> You can monitor the progress in the [AWS Console](https://console.aws.amazon.com/) under **CodePipeline** or **Elastic Beanstalk**.

---

## 2. Manual Deployment (Using EB CLI)
Since you have an `.elasticbeanstalk` configuration folder, you can also deploy directly from your terminal:

1. Ensure you have the [EB CLI installed](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/eb-cli-install.html).
2. Run the deployment command from the project root:
   ```bash
   eb deploy
   ```
This will package your local code and upload it directly to AWS.

---

## 3. Managing Environment Variables
Since you are no longer on `localhost`, ensure your production settings (Database URL, Secret Keys, etc.) are set in the AWS Console:

1. Go to the **Elastic Beanstalk** console.
2. Select your environment: `tech-trolley-env`.
3. Go to **Configuration** -> **Updates, monitoring, and logging** -> **Edit**.
4. Scroll down to **Environment properties** and add your variables there.

---

## 4. Viewing Logs
If something goes wrong after a "pull" (deployment), you can view the server logs:
- **Via CLI**: `eb logs`
- **Via Console**: Go to the "Logs" section in your Elastic Beanstalk environment.

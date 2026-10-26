pipeline {
    agent { label 'linux-docker-builder' }
    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        timeout(time: 40, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '5', artifactNumToKeepStr: '2'))
    }
    parameters {
        booleanParam(name: 'DEPLOY_LIGHTSAIL', defaultValue: false,
            description: '수동 빌드의 배포 선택입니다. develop-backend 웹훅 빌드는 검증 성공 후 자동 배포합니다.')
    }
    stages {
        stage('Checkout') {
            steps {
                script {
                    def source = checkout scm
                    env.SOURCE_BRANCH = source.GIT_BRANCH ?: ''
                    env.SOURCE_COMMIT = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    env.RELEASE_VERSION = "${env.SOURCE_COMMIT.take(12)}-${env.BUILD_NUMBER}"
                }
            }
        }
        stage('Verify') {
            steps {
                sh '''
                    set -eu
                    test -f backend/package-lock.json
                    test -f compose.prod.yaml
                    bash -n infra/deploy/package.sh infra/deploy/upload.sh infra/deploy/deploy.sh infra/deploy/should-deploy.sh
                    sh -n infra/database/migrate.sh
                    bash infra/deploy/test-deploy-trigger.sh
                    bash infra/deploy/test-deploy.sh
                    bash infra/deploy/test-linux-release.sh
                    node --version
                    docker version
                '''
            }
        }
        stage('Backend checks') {
            steps {
                sh 'node backend/scripts/check.cjs'
            }
        }
        stage('Build and Package Images') {
            steps {
                // NestJS compilation runs inside the backend Docker build stage.
                sh 'bash infra/deploy/package.sh "$RELEASE_VERSION"'
                archiveArtifacts artifacts: ".deploy/${env.RELEASE_VERSION}/**", onlyIfSuccessful: true
            }
        }
        stage('Verify Deployment Access') {
            steps {
                withCredentials([sshUserPrivateKey(credentialsId: 'dva-lightsail-ssh',
                    keyFileVariable: 'LIGHTSAIL_SSH_KEY', usernameVariable: 'LIGHTSAIL_SSH_USER')]) {
                    sh 'bash infra/deploy/upload.sh "$RELEASE_VERSION" "$LIGHTSAIL_SSH_KEY" "$LIGHTSAIL_SSH_USER" --verify-only'
                }
            }
        }
        stage('Deploy to Lightsail') {
            when {
                expression {
                    sh(script: "bash infra/deploy/should-deploy.sh '${params.DEPLOY_LIGHTSAIL}'", returnStatus: true) == 0
                }
            }
            options { timeout(time: 15, unit: 'MINUTES') }
            steps {
                withCredentials([sshUserPrivateKey(credentialsId: 'dva-lightsail-ssh',
                    keyFileVariable: 'LIGHTSAIL_SSH_KEY', usernameVariable: 'LIGHTSAIL_SSH_USER')]) {
                    sh 'bash infra/deploy/upload.sh "$RELEASE_VERSION" "$LIGHTSAIL_SSH_KEY" "$LIGHTSAIL_SSH_USER"'
                }
            }
        }
    }
    post {
        success { echo 'Dva Linux CI 파이프라인 성공' }
        failure { echo 'Dva Linux CI 파이프라인 실패' }
    }
}


pipeline {
    agent any

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '5', artifactNumToKeepStr: '2'))
    }

    stages {
        stage('Checkout') {
            steps {
                echo 'GitLab 저장소에서 코드 가져오기'
                checkout scm
                script {
                    env.SOURCE_COMMIT = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    env.RELEASE_VERSION = "${env.SOURCE_COMMIT.take(12)}-${env.BUILD_NUMBER}"
                }
            }
        }

        stage('Verify') {
            steps {
                script {
                    def files = [
                        'README.md',
                        'compose.yaml',
                        'backend/Dockerfile',
                        'ai/Dockerfile',
                        'compose.prod.yaml',
                        'infra/nginx/default.prod.conf',
                        'infra/deploy/package.ps1',
                        'infra/deploy/deploy.sh'
                    ]

                    files.each { file ->
                        if (!fileExists(file)) {
                            error "파일을 찾을 수 없습니다: ${file}"
                        }
                    }
                }

                echo '프로젝트 기본 구조 검증 성공'
            }
        }
        
        stage('Build Backend') {
            steps {
                nodejs(nodeJSInstallationName: 'node24') {
                    dir('backend') {
                        echo 'Node.js 버전 확인'
                        sh 'node --version'

                        echo '의존성 설치'
                        sh 'npm ci'

                        echo 'NestJS 빌드'
                        sh 'npm run build'
                    }
                }
            }
        }

        
        stage('Build and Package Images') {
            agent {
                label 'docker-builder'
            }

            steps {
                checkout scm
                powershell '''
                    $ErrorActionPreference = 'Stop'
                    git checkout --detach $env:SOURCE_COMMIT
                    if ($LASTEXITCODE -ne 0) { throw 'Cannot check out the verified commit.' }
                    & ./infra/deploy/package.ps1 -Version $env:RELEASE_VERSION
                '''
                archiveArtifacts artifacts: ".deploy/${env.RELEASE_VERSION}/**", onlyIfSuccessful: true
            }
        }
    }

    post {
        success {
            echo 'Dva CI 파이프라인 성공'
        }
        failure {
            echo 'Dva CI 파이프라인 실패'
        }
    }
}

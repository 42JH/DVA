
pipeline {
    agent any

    options {
        skipDefaultCheckout(true)
    }

    stages {
        stage('Checkout') {
            steps {
                echo 'GitLab 저장소에서 코드 가져오기'
                checkout scm
            }
        }

        stage('Verify') {
            steps {
                script {
                    def files = [
                        'README.md',
                        'compose.yaml',
                        'backend/Dockerfile',
                        'ai-agent/Dockerfile'
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

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # State lives in S3 (see bootstrap/). Fill in the bucket with: terraform init -backend-config=backend.hcl
  backend "s3" {
    key          = "armable/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "armable", Environment = var.environment, ManagedBy = "terraform" } }
}
# CloudFront certificates must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags { tags = { Project = "armable", Environment = var.environment, ManagedBy = "terraform" } }
}
